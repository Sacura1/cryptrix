import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, formatUnits, getAddress, http, keccak256, parseAbi, parseTransaction, parseUnits, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc } from 'viem/chains';
import { compileBuild } from './compile-contracts.js';
import { ArcGateway, USDC } from '../src/chain.js';
import { SignerKeystore } from '../src/payments/keystore.js';
import { MIN_FEE, MAX_FEE } from '../src/payments/signer.js';

const journalPath = 'data/deployment-arc-mainnet-v4.json';
const manifestPath = '../docs/deployments/arc-mainnet.json';
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const contractAbi = parseAbi(['function owner() view returns (address)', 'function feeRecipient() view returns (address)', 'function FEE_BPS() view returns (uint256)']);
class DeploymentError extends Error {}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new DeploymentError(message); }
function fingerprint(value: string) { return createHash('sha256').update(value).digest('hex'); }
function saveJson(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function envLine(value: string) {
  check(!/[\r\n"']/u.test(value), 'An environment value contains unsupported quotes or line breaks. URL-encode database credentials.');
  return `"${value}"`;
}
export function renderEnvironment(source: string, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) source = source.replace(new RegExp(`^${name}=.*$`, 'm'), () => `${name}=${envLine(value)}`);
  const parsed = parseEnv(source);
  check(Object.entries(values).every(([name, value]) => parsed[name] === value), 'Generated environment differs from the requested settings.');
  return source;
}
function initialiseEnvironment() {
  check(!existsSync('.env.mainnet'), 'backend/.env.mainnet already exists. Edit it; do not replace its signer encryption key.');
  let source = readFileSync('.env.mainnet.example', 'utf8');
  source = source.replace(/^SIGNER_ENCRYPTION_KEY=.*$/m, `SIGNER_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
  writeFileSync('.env.mainnet', source, { flag: 'wx', mode: 0o600 });
  console.log('Created ignored backend/.env.mainnet with a signer encryption key. Add your mainnet deployment key and signer Neon URL. To keep the current Koyeb encryption key, use that value before the first deployment. No transaction was sent.');
}
export function deploymentSettings(env: NodeJS.ProcessEnv) {
  const issues: string[] = [];
  if (env.ARC_NETWORK !== 'mainnet') issues.push('ARC_NETWORK=mainnet');
  const supplied = [env.key, env.DEPLOYER_PRIVATE_KEY, env.PRIVATE_KEY].filter(Boolean).map(value => value!.replace(/^0x/, '').toLowerCase());
  if (!supplied.length || !supplied.every(value => value === supplied[0]) || !/^[0-9a-f]{64}$/.test(supplied[0]!)) issues.push('key=<mainnet deployment private key>; remove conflicting inherited PRIVATE_KEY/DEPLOYER_PRIVATE_KEY values');
  const namespace = env.SIGNER_STATE_NAMESPACE ?? 'signer:mainnet:v4';
  const database = env.SIGNER_DATABASE_URL ?? '';
  const encryption = env.SIGNER_ENCRYPTION_KEY ?? '';
  if (!/^signer:mainnet(?::[a-zA-Z0-9_-]+)*$/.test(namespace)) issues.push('SIGNER_STATE_NAMESPACE=signer:mainnet:v4');
  if (!/^postgres(ql)?:\/\//.test(database)) issues.push('SIGNER_DATABASE_URL=<existing signer Neon URL>');
  if (Buffer.from(encryption, 'base64').length !== 32) issues.push('SIGNER_ENCRYPTION_KEY=<32-byte base64 key used by the mainnet signer>');
  check(!issues.length, `Complete these settings in backend/.env.mainnet:\n${issues.join('\n')}`);
  return { secret: `0x${supplied[0]}` as Hex, namespace, database, encryption, rpc: env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io' };
}
function clients(secret: Hex, rpc: string) {
  const account = privateKeyToAccount(secret);
  return {
    account,
    client: createPublicClient({ chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 1 }) }),
    wallet: createWalletClient({ account, chain: arc, transport: http(rpc, { timeout: 20_000, retryCount: 0 }) }),
  };
}
type Clients = ReturnType<typeof clients>;
interface Operation { raw: Hex; hash: Hex; nonce: number; payloadHash: Hex; to: Address | null; cost: string }
interface Journal {
  chainId: number; deployer: Address; owner: Address; namespace: string; storageFingerprint: string; encryptionFingerprint: string;
  bytecodeHash: Hex; fundingUnits: string; maxSpend: string; resolver?: Address; keeper?: Address;
  build: ReturnType<typeof compileBuild>;
  operations: Record<string, Operation>;
}

// Persist the exact signed transaction before submitting it. A retry never signs a replacement.
export async function sendDeploymentTransaction(
  { client, wallet, account }: Clients, journal: Journal, save: () => void,
  name: string, to: Address | undefined, data: Hex, transferUnits = 0n,
) {
  let operation = journal.operations[name];
  const payloadHash = keccak256(data);
  check(!operation || (operation.payloadHash === payloadHash && operation.to === (to ?? null) && keccak256(operation.raw) === operation.hash), 'Saved transaction does not match this deployment. Preserve the journal and investigate.');
  if (!operation) {
    const fees = await client.estimateFeesPerGas();
    const quotedFee = fees.maxFeePerGas ?? MIN_FEE;
    const maxFeePerGas = quotedFee < MIN_FEE ? MIN_FEE : quotedFee;
    check(maxFeePerGas <= MAX_FEE, 'Network gas price exceeds the deployment fee ceiling. Retry later.');
    const estimate = await client.estimateGas({ account: account.address, to, data, value: 0n });
    const gas = estimate + estimate / 5n;
    const cost = gas * maxFeePerGas + transferUnits * 1_000_000_000_000n;
    const reserved = Object.values(journal.operations).reduce((total, item) => total + BigInt(item.cost), 0n);
    check(reserved + cost <= BigInt(journal.maxSpend), 'Deployment spending cap would be exceeded. No new transaction was signed.');
    check(await client.getBalance({ address: account.address }) >= cost, 'Deployment wallet needs more mainnet USDC for this transfer and gas.');
    const request = await wallet.prepareTransactionRequest({ type: 'eip1559', to, data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n });
    const raw = await wallet.signTransaction(request);
    operation = { raw, hash: keccak256(raw), nonce: request.nonce, payloadHash, to: to ?? null, cost: String(cost) };
    journal.operations[name] = operation;
    save();
  }
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: operation.hash }); }
  catch (error) { if (!(error instanceof TransactionReceiptNotFoundError)) throw error; }
  if (!receipt) {
    check(await client.getTransactionCount({ address: account.address, blockTag: 'latest' }) <= operation.nonce, 'Saved nonce has already been used by another transaction. Do not delete the journal or redeploy; inspect the wallet history.');
    // A node can reject an already-known transaction. Still check its original receipt.
    try { await client.sendRawTransaction({ serializedTransaction: operation.raw }); } catch { /* receipt below determines success */ }
    receipt = await client.waitForTransactionReceipt({ hash: operation.hash, timeout: 55_000 });
  }
  check(receipt.status === 'success', `Transaction ${name} reverted. Preserve the journal and inspect ${operation.hash}.`);
  console.log(`${name}: https://explorer.arc.io/tx/${receipt.transactionHash}`);
  return receipt;
}

export async function deployMainnet(broadcast: boolean) {
  const { secret, namespace, database, encryption, rpc } = deploymentSettings(process.env);
  const context = clients(secret, rpc);
  const { account, client } = context;
  check(await client.getChainId() === 5042, 'RPC is not Arc mainnet (5042). Nothing was sent.');
  const owner = getAddress(process.env.FEE_OWNER || account.address);
  check(owner !== zeroAddress, 'FEE_OWNER cannot be the zero address.');
  const fundingSetting = process.env.MAINNET_SERVICE_USDC ?? '0.25';
  const spendingSetting = process.env.MAINNET_MAX_SPEND_USDC ?? '1';
  check(/^\d+(?:\.\d{1,6})?$/.test(fundingSetting), 'MAINNET_SERVICE_USDC must be a positive decimal with at most six decimal places.');
  check(/^\d+(?:\.\d{1,18})?$/.test(spendingSetting), 'MAINNET_MAX_SPEND_USDC must be a positive decimal with at most eighteen decimal places.');
  const funding = parseUnits(fundingSetting, 6);
  const maxSpend = parseUnits(spendingSetting, 18);
  check(funding >= 50_000n && funding <= 1_000_000n, 'MAINNET_SERVICE_USDC must be between 0.05 and 1 USDC per service wallet.');
  check(maxSpend > funding * 2n * 1_000_000_000_000n, 'Spending cap must cover both service wallets plus deployment gas.');
  const build = compileBuild(true);
  const artifact = build.artifacts.GameEscrow!;
  const journal: Journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {
    chainId: 5042, deployer: account.address, owner, namespace, storageFingerprint: fingerprint(database), encryptionFingerprint: fingerprint(encryption),
    bytecodeHash: keccak256(artifact.bytecode), fundingUnits: String(funding), maxSpend: String(maxSpend), build, operations: {},
  };
  check(journal.chainId === 5042 && journal.deployer === account.address && journal.owner === owner && journal.namespace === namespace && journal.storageFingerprint === fingerprint(database) && journal.encryptionFingerprint === fingerprint(encryption) && journal.bytecodeHash === keccak256(artifact.bytecode) && journal.fundingUnits === String(funding) && journal.maxSpend === String(maxSpend), 'Deployment settings differ from the saved journal. Restore the original settings; do not delete recovery files.');
  check(!existsSync(manifestPath) || existsSync(journalPath), 'A mainnet manifest exists but its recovery journal is missing. Recover the original journal before deploying again.');
  const data = encodeDeployData({ ...artifact, args: [USDC, journal.resolver ?? account.address, owner] });
  const gas = await client.estimateGas({ account: account.address, data, value: 0n });
  const fees = await client.estimateFeesPerGas();
  const quotedFee = fees.maxFeePerGas ?? MIN_FEE;
  const fee = quotedFee < MIN_FEE ? MIN_FEE : quotedFee;
  check(fee <= MAX_FEE, 'Network gas price exceeds the deployment fee ceiling. Retry later.');
  const deploymentCeiling = (gas + gas / 5n) * fee;
  // Two transfer estimates use a conservative 100k gas allowance each. Actual sends are estimated separately.
  const initialCeiling = deploymentCeiling + 200_000n * fee + funding * 2n * 1_000_000_000_000n;
  const balance = await client.readContract({ address: USDC, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
  console.log(JSON.stringify({ mode: broadcast ? 'broadcast' : 'preview only', chainId: 5042, deployer: account.address, feeOwner: owner,
    balanceUsdc: formatUnits(balance, 6), deploymentGasCeilingUsdc: formatUnits(deploymentCeiling, 18),
    serviceFundingUsdcEach: formatUnits(funding, 6), initialEstimatedCeilingUsdc: formatUnits(initialCeiling, 18), spendingCapUsdc: formatUnits(maxSpend, 18),
    signerNamespace: namespace, resolver: journal.resolver ?? 'generated and saved on broadcast; preview uses deployer as placeholder',
    audited: false }, null, 2));
  if (!broadcast) { console.log('Preview complete. No keys were created, database state changed, or transactions sent.'); return; }
  if (!Object.keys(journal.operations).length) {
    check(initialCeiling <= maxSpend, 'Initial estimate exceeds MAINNET_MAX_SPEND_USDC. Nothing was sent.');
    check(balance * 1_000_000_000_000n >= initialCeiling, 'Not enough mainnet USDC for deployment, service funding and gas. Nothing was sent.');
  }
  mkdirSync('data', { recursive: true });
  const lockPath = `${journalPath}.lock`;
  check(!existsSync(lockPath), 'A deployment lock exists. Ensure no deployment process is running before removing only the .lock file.');
  writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  const save = () => saveJson(journalPath, journal);
  try {
    if (!journal.resolver || !journal.keeper) {
      // Persist service keys in the same durable namespace the deployed signer will use.
      // Do not run the mainnet signer while this first-time bootstrap holds its database lease.
      const keys = await SignerKeystore.open('./data/signer/mainnet.sqlite', Buffer.from(encryption, 'base64'), database, namespace);
      try {
        journal.resolver = getAddress(keys.account('resolver').address);
        journal.keeper = getAddress(keys.account('keeper').address);
        await keys.flush();
        save();
      } finally { await keys.shutdown(); }
    }
    const receipt = await sendDeploymentTransaction(context, journal, save, 'escrow', undefined, encodeDeployData({ ...artifact, args: [USDC, journal.resolver, owner] }));
    check(receipt.contractAddress, 'Deployment receipt has no contract address.');
    const escrow = getAddress(receipt.contractAddress);
    const gateway = new ArcGateway(escrow, 'mainnet', process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io');
    await gateway.initialise();
    const [actualOwner, recipient, feeBps] = await Promise.all((['owner', 'feeRecipient', 'FEE_BPS'] as const).map(functionName => client.readContract({ address: escrow, abi: contractAbi, functionName })));
    check(gateway.resolver === journal.resolver && actualOwner === owner && recipient === owner && feeBps === 100n, 'Deployed contract configuration does not match the intended resolver, owner and 1% fee.');
    for (const [role, address] of [['resolver', journal.resolver], ['keeper', journal.keeper]] as const) {
      const operation = `fund-${role}`;
      if (journal.operations[operation]) {
        // Resume the original amount even if the wallet already received it.
        const previousData = parseTransaction(journal.operations[operation]!.raw).data!;
        await sendDeploymentTransaction(context, journal, save, operation, USDC, previousData);
      } else {
        const current = await client.readContract({ address: USDC, abi: tokenAbi, functionName: 'balanceOf', args: [address!] });
        if (current < funding) {
          const amount = funding - current;
          await sendDeploymentTransaction(context, journal, save, operation, USDC, encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [address!, amount] }), amount);
        }
      }
    }
    const manifest = { network: 'Arc mainnet', chainId: 5042, usdc: USDC, version: 4, escrow, deployer: account.address, resolver: journal.resolver,
      keeper: journal.keeper, feeOwner: owner, feeRecipient: owner, feeBps: 100, signerNamespace: namespace,
      escrowDeploymentBlock: String(receipt.blockNumber), escrowTransaction: receipt.transactionHash,
      bytecodeHash: journal.bytecodeHash, compiler: build.compiler, evmVersion: 'cancun', optimizerRuns: 200, viaIR: true, audited: false };
    mkdirSync('../docs/deployments', { recursive: true });
    saveJson(manifestPath, manifest);
    // Output only settings that change for mainnet. Existing Koyeb service credentials stay untouched.
    mkdirSync('data/mainnet', { recursive: true });
    const common = { ARC_NETWORK: 'mainnet', ARC_RPC_URL: rpc, ESCROW_ADDRESS: escrow };
    const environments = {
      api: { ...common, STATE_NAMESPACE: 'backend:mainnet:external-v4', ESCROW_DEPLOYMENT_BLOCK: String(receipt.blockNumber) },
      signer: { ...common, SIGNER_STATE_NAMESPACE: namespace, SIGNER_ENCRYPTION_KEY: encryption },
    };
    for (const [service, values] of Object.entries(environments)) {
      const source = renderEnvironment(readFileSync(`.env.mainnet.${service}.example`, 'utf8'), values);
      writeFileSync(`data/mainnet/${service}.env`, source, { mode: 0o600 });
    }
    console.log(`Mainnet deployment complete. Public manifest: ${manifestPath}`);
    console.log(`API + signer: ESCROW_ADDRESS=${escrow}\nAPI: ESCROW_DEPLOYMENT_BLOCK=${receipt.blockNumber}`);
    console.log('Keep the signer encryption key, database namespace and deployment recovery journal. Explorer source verification is a separate command.');
    console.log('Koyeb changes only: data/mainnet/{api,signer}.env. Keep existing ports, hosts, database URLs, service URLs and tokens. Frontend needs no changes if the API URL stays the same.');
  } finally { unlinkSync(lockPath); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = async () => {
    check(args.length <= 1 && args.every(arg => arg === '--broadcast' || arg === '--init'), 'Usage: npm run arc:mainnet:deploy -- [--init | --broadcast]');
    if (args.includes('--init')) initialiseEnvironment();
    else await deployMainnet(args.includes('--broadcast'));
  };
  run().catch(error => {
    console.error(error instanceof DeploymentError ? error.message : 'Mainnet preparation/deployment stopped. Check RPC/database availability and preserve data/deployment-arc-mainnet-v4.json before retrying. No private keys were logged.');
    process.exitCode = 1;
  });
}
