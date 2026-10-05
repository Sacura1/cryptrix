import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, formatUnits, getAddress, http, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { arcTestnet } from 'viem/chains';
import { SignerKeystore } from '../src/payments/keystore.js';
import { ArcGateway, USDC } from '../src/chain.js';
import { MIN_FEE, MAX_FEE } from '../src/payments/signer.js';
const publicPath = '../docs/deployments/arc-testnet.json';
const journalPath = './data/deployment-arc-testnet-v3.json';
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
function updateEnv(path: string, values: Record<string,string>) {
  let source = existsSync(path) ? readFileSync(path,'utf8') : '';
  for (const [name,value] of Object.entries(values)) {
    const expression = new RegExp(`^${name}=.*$`,'m');
    source = expression.test(source) ? source.replace(expression, `${name}=${value}`) : source.trimEnd()+`\n${name}=${value}\n`;
  }
  writeFileSync(path,source,{mode:0o600});
}
async function run() {
  const secret = process.env.key ?? process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!secret || !/^(0x)?[0-9a-fA-F]{64}$/.test(secret)) throw new Error('DEPLOYER_KEY_MISSING');
  const account = privateKeyToAccount((secret.startsWith('0x') ? secret : `0x${secret}`) as Hex);
  const rpc = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io';
  const client = createPublicClient({chain:arcTestnet,transport:http(rpc,{timeout:20000,retryCount:1})});
  const wallet = createWalletClient({account,chain:arcTestnet,transport:http(rpc,{timeout:20000,retryCount:0})});
  if (await client.getChainId() !== 5042002) throw new Error('WRONG_CHAIN');
  const balance = await client.readContract({address:USDC,abi:tokenAbi,functionName:'balanceOf',args:[account.address]});
  if (balance < 2000000n) throw new Error('DEPLOYER_NEEDS_TEST_USDC');
  mkdirSync('data',{recursive:true}); mkdirSync('../docs/deployments',{recursive:true});
  // Reuse public service addresses on redeployment without opening the live signer database.
  const previous = existsSync(publicPath) ? JSON.parse(readFileSync(publicPath,'utf8')) : undefined;
  const signerEnv = existsSync('.env.signer') ? parseEnv(readFileSync('.env.signer','utf8')) : {};
  if (previous && (!signerEnv.SIGNER_ENCRYPTION_KEY || !signerEnv.SIGNER_TOKEN)) throw new Error('EXISTING_SIGNER_CREDENTIALS_REQUIRED');
  const encryption = signerEnv.SIGNER_ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  const credential = signerEnv.SIGNER_TOKEN ?? randomBytes(32).toString('hex');
  const signerUrl = signerEnv.SIGNER_DATABASE_URL ?? process.env.DATABASE_URL;
  updateEnv('.env.signer',{ SIGNER_TOKEN:credential, SIGNER_ENCRYPTION_KEY:encryption,
    SIGNER_HOST:'127.0.0.1',SIGNER_PORT:'3012',SIGNER_DATABASE:'./data/signer/keys.sqlite',
    ARC_NETWORK:'testnet',ARC_RPC_URL:rpc,GAS_SPONSOR_ENABLED:'true',GAS_BUDGET_USDC:'3',GAS_TOPUP_USDC:'0.05',
    ...(signerUrl ? {SIGNER_DATABASE_URL:signerUrl} : {}) });
  const keys = previous ? undefined : await SignerKeystore.open('./data/signer/keys.sqlite',Buffer.from(encryption,'base64'),signerUrl,signerEnv.SIGNER_STATE_NAMESPACE ?? 'signer:testnet');
  try {
    const resolver = getAddress(previous?.resolver ?? keys!.account('resolver').address);
    const keeper = getAddress(previous?.keeper ?? keys!.account('keeper').address);
    const sponsor = getAddress(previous?.gasSponsor ?? keys!.account('gas').address);
    if (previous) {
      if (previous.chainId !== 5042002) throw new Error('WRONG_CHAIN');
      const previousAbi = parseAbi(['function resolver() view returns (address)', 'function usdc() view returns (address)']);
      const oldResolver = await client.readContract({address:getAddress(previous.escrow),abi:previousAbi,functionName:'resolver'});
      const oldToken = await client.readContract({address:getAddress(previous.escrow),abi:previousAbi,functionName:'usdc'});
      if (oldResolver.toLowerCase() !== resolver.toLowerCase() || oldToken.toLowerCase() !== USDC.toLowerCase()) throw new Error('EXISTING_DEPLOYMENT_MISMATCH');
    }
    await keys?.flush();
    const journal: Record<string,any> = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath,'utf8')) : {};
    if (journal.deployer && journal.deployer !== account.address) throw new Error('DEPLOYER_CHANGED');
    journal.deployer=account.address; journal.chainId=5042002;
    const save = () => writeFileSync(journalPath,JSON.stringify(journal,null,2));
    async function send(name: string, to: Address | undefined, data: Hex) {
      let operation = journal[name];
      const payloadHash = keccak256(data);
      if (operation && (operation.payloadHash !== payloadHash || operation.to !== (to ?? null))) throw new Error('PREPARED_TRANSACTION_MISMATCH');
      if (!operation) {
        const fees=await client.estimateFeesPerGas(); const fee=fees.maxFeePerGas! < MIN_FEE ? MIN_FEE : fees.maxFeePerGas!;
        if(fee>MAX_FEE)throw new Error('FEE_CEILING');
        const estimate=await client.estimateGas({account:account.address,to,data,value:0n});
        const request=await wallet.prepareTransactionRequest({type:'eip1559',to,data,value:0n,gas:estimate+estimate/5n,maxFeePerGas:fee,maxPriorityFeePerGas:fees.maxPriorityFeePerGas??0n});
        const raw=await wallet.signTransaction(request), hash=keccak256(raw);
        operation=journal[name]={raw,hash,nonce:request.nonce,payloadHash,to:to ?? null}; save();
      }
      let receipt;
      try { receipt=await client.getTransactionReceipt({hash:operation.hash}); } catch { }
      if(!receipt){ await client.sendRawTransaction({serializedTransaction:operation.raw}); receipt=await client.waitForTransactionReceipt({hash:operation.hash,timeout:120000}); }
      if(receipt.status!=='success')throw new Error('DEPLOYMENT_TRANSACTION_REVERTED');
      operation.block=String(receipt.blockNumber);operation.address=receipt.contractAddress;operation.confirmed=true;save();
      console.log(JSON.stringify({operation:name,hash:operation.hash,block:operation.block,address:operation.address}));
      return receipt;
    }
    const artifact=(name:string)=>JSON.parse(readFileSync(`artifacts/${name}.json`,'utf8'));
    const escrowArtifact=artifact('GameEscrow');
    const escrowReceipt=await send('escrow',undefined,encodeDeployData({...escrowArtifact,args:[USDC,resolver]}));
    const escrow=getAddress(escrowReceipt.contractAddress!);
    const gateway=new ArcGateway(escrow,'testnet',rpc);await gateway.initialise();
    if(gateway.resolver?.toLowerCase()!==resolver.toLowerCase())throw new Error('RESOLVER_MISMATCH');
    for(const [role,address] of [['resolver',resolver],['keeper',keeper],['gas',sponsor]] as const) {
      const current=await client.readContract({address:USDC,abi:tokenAbi,functionName:'balanceOf',args:[address]});
      if(current<50000n) await send(`fund-${role}`,USDC,encodeFunctionData({abi:tokenAbi,functionName:'transfer',args:[address,role==='gas'?1000000n:100000n]}));
    }
    const manifest={network:'Arc testnet',chainId:5042002,usdc:USDC,deployer:account.address,resolver,keeper,gasSponsor:sponsor,
      version:3,escrow,escrowDeploymentBlock:String(escrowReceipt.blockNumber),
      escrowTransaction:escrowReceipt.transactionHash,solidity:'0.8.30',evmVersion:'cancun',optimizerRuns:200,viaIR:true,
      audited:false,createdAt:new Date().toISOString()};
    if (existsSync(publicPath)) { const previous=JSON.parse(readFileSync(publicPath,'utf8')); if(previous.escrow!==escrow) writeFileSync(`../docs/deployments/arc-testnet-v${previous.version ?? 1}.json`,JSON.stringify(previous,null,2)); }
    writeFileSync(publicPath,JSON.stringify(manifest,null,2));
    updateEnv('.env.signer',{ESCROW_ADDRESS:escrow,AGENT_ACCOUNT_FACTORY:''});
    updateEnv('.env',{ARC_NETWORK:'testnet',ARC_RPC_URL:rpc,ESCROW_ADDRESS:escrow,AGENT_ACCOUNT_FACTORY:'',ESCROW_DEPLOYMENT_BLOCK:String(escrowReceipt.blockNumber),
      SIGNER_URL:'http://127.0.0.1:3012',SIGNER_TOKEN:credential,OPS_TOKEN:process.env.OPS_TOKEN??randomBytes(32).toString('hex'),MATCH_MODE:'paid',STATE_NAMESPACE:'backend:testnet:external-v3',DATABASE_PATH:'./data/platform-v3.sqlite'});
    console.log(JSON.stringify({verified:true,...manifest}));
  } finally { await keys?.shutdown(); }
}
run().catch(()=>{console.error('Arc testnet deployment did not complete. Prepared transactions are retained for safe retry; no keys were logged.');process.exitCode=1});
