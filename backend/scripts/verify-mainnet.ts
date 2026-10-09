import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import solc from 'solc';
import { createPublicClient, encodeAbiParameters, encodeDeployData, http, keccak256, parseAbiParameters, type Abi, type Hex } from 'viem';
import { arc } from 'viem/chains';

// Uses the saved deployment build, including its imported sources and all three constructor arguments.
// Preview verifies the onchain creation transaction; publishing requires --publish.
async function run() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== '--publish')) throw new Error('Use npm run arc:mainnet:verify -- [--publish].');
  if (process.env.ARC_NETWORK !== 'mainnet') throw new Error('Set ARC_NETWORK=mainnet in .env.mainnet.');
  const manifest = JSON.parse(readFileSync('../docs/deployments/arc-mainnet.json', 'utf8'));
  const journal = JSON.parse(readFileSync('data/deployment-arc-mainnet-v4.json', 'utf8'));
  const build = journal.build;
  if (manifest.chainId !== 5042 || journal.chainId !== 5042 || build.compiler !== solc.version() || manifest.compiler !== build.compiler) throw new Error('Network or compiler differs from the saved mainnet deployment.');
  const compiled = JSON.parse(solc.compile(JSON.stringify(build.input)));
  if (compiled.errors?.some((error: { severity: string }) => error.severity === 'error')) throw new Error('Saved standard JSON build could not be compiled.');
  const artifact: { abi: Abi; bytecode: Hex } = { abi: compiled.contracts['contracts/GameEscrow.sol'].GameEscrow.abi,
    bytecode: `0x${compiled.contracts['contracts/GameEscrow.sol'].GameEscrow.evm.bytecode.object}` };
  if (keccak256(artifact.bytecode) !== manifest.bytecodeHash || journal.bytecodeHash !== manifest.bytecodeHash) throw new Error('Verification bytecode differs from the deployed build.');
  const client = createPublicClient({ chain: arc, transport: http(process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io', { timeout: 20_000 }) });
  if (await client.getChainId() !== 5042) throw new Error('RPC is not Arc mainnet.');
  const [transaction, receipt] = await Promise.all([client.getTransaction({ hash: manifest.escrowTransaction }), client.getTransactionReceipt({ hash: manifest.escrowTransaction })]);
  const constructorArgs = [manifest.usdc, manifest.resolver, manifest.feeOwner];
  const expected = encodeDeployData({ ...artifact, args: constructorArgs });
  if (transaction.input !== expected || transaction.from.toLowerCase() !== manifest.deployer.toLowerCase() || receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== manifest.escrow.toLowerCase()) throw new Error('Onchain creation transaction does not match the manifest and saved source.');
  console.log(`Deployment build matches the onchain creation transaction: https://explorer.arc.io/address/${manifest.escrow}`);
  if (!args.includes('--publish')) { console.log('Preview only. To publish the contract source: npm run arc:mainnet:verify -- --publish'); return; }
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/arc-mainnet-standard-input.json', JSON.stringify(build.input));
  const compiler = `v${build.compiler.split('.Emscripten')[0]}`;
  const form = new URLSearchParams({ module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: manifest.escrow, contractname: 'contracts/GameEscrow.sol:GameEscrow', compilerversion: compiler,
    sourceCode: JSON.stringify(build.input), constructorArguments: encodeAbiParameters(parseAbiParameters('address,address,address'), constructorArgs as [`0x${string}`, `0x${string}`, `0x${string}`]).slice(2) });
  async function explorer(body?: URLSearchParams, guid?: string) {
    const url = guid ? `https://explorer.arc.io/api?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}` : 'https://explorer.arc.io/api';
    const response = await fetch(url, { method: body ? 'POST' : 'GET', body, headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined, signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error('Explorer request failed. Saved standard input is available for manual verification.');
    return await response.json() as { status: string; result: string };
  }
  const submission = await explorer(form);
  if (/already verified/i.test(submission.result)) { console.log('Contract source is already verified.'); return; }
  if (submission.status !== '1' || !/^[a-zA-Z0-9-]+$/.test(submission.result)) throw new Error('Explorer rejected the verification submission. Use the saved standard input and matching compiler settings for manual verification.');
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const status = await explorer(undefined, submission.result);
    if (status.status === '1' || /already verified/i.test(status.result)) { console.log(`Contract source verified: https://explorer.arc.io/address/${manifest.escrow}?tab=contract`); return; }
    if (!/pending|queue|in progress/i.test(status.result)) throw new Error('Explorer verification failed. Inspect the saved standard input and deployed compiler settings.');
  }
  throw new Error('Verification is still pending. Check the contract page later; successful verification has not been confirmed.');
}
run().catch(() => { console.error('Mainnet verification did not complete. Check the mainnet manifest, saved deployment journal, compiler and RPC/explorer availability. No deployment or payment was sent.'); process.exitCode = 1; });
