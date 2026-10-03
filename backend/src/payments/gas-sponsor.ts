import { encodeFunctionData, getAddress, keccak256, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import { USDC, type ArcGateway } from '../chain.js';
import { requireThat } from '../domain.js';
import { MIN_FEE, MAX_FEE } from './signer.js';
import { SignerKeystore } from './keystore.js';
const abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
/** Sponsors only this keystore's scoped service keys, never a caller-supplied recipient. */
export class GasSponsor {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly checked = new Map<string, number>();
  constructor(private readonly keys: SignerKeystore, private readonly chain: ArcGateway,
    private readonly topup = parseUnits(process.env.GAS_TOPUP_USDC ?? '0.05', 6),
    private readonly daily = parseUnits(process.env.GAS_BUDGET_USDC ?? '3', 6)) {
    requireThat(topup > 0n && topup <= 1000000n && daily >= topup && daily <= 100000000n, 'GAS_CONFIG', 'Invalid sponsor budget', 503);
    keys.db.exec(`CREATE TABLE IF NOT EXISTS gas_topups(operation TEXT PRIMARY KEY, scope TEXT NOT NULL,
      recipient TEXT NOT NULL, day INTEGER NOT NULL, amount TEXT NOT NULL, nonce INTEGER NOT NULL UNIQUE,
      hash TEXT NOT NULL, raw TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0);`);
  }
  async ensure(scope: string): Promise<void> {
    if (scope === 'gas') return;
    const task = this.queue.then(() => this.perform(scope));
    this.queue = task.catch(() => {});
    await task;
  }
  private async perform(scope: string) {
    if (Date.now() - (this.checked.get(scope) ?? 0) < 20000) return;
    const target = this.keys.account(scope).address;
    await this.keys.flush();
    // Recover every prepared transfer first. Lost RPC replies reuse exactly the same signed bytes.
    for (const row of this.keys.db.prepare('SELECT * FROM gas_topups WHERE confirmed=0 ORDER BY nonce').all()) {
      await this.broadcast(String(row.operation), String(row.raw) as Hex, String(row.hash) as Hex);
    }
    const balance = await this.chain.client.readContract({address: USDC, abi, functionName: 'balanceOf', args:[target]});
    if (balance >= 10000n) { this.checked.set(scope, Date.now()); return; }
    const account = this.keys.account('gas');
    const block = await this.chain.client.getBlock();
    const day = Number(block.timestamp / 86400n);
    const spent = this.keys.db.prepare('SELECT amount FROM gas_topups WHERE day=?').all(day).reduce((n,row)=>n+BigInt(String(row.amount)),0n);
    requireThat(spent + this.topup <= this.daily, 'GAS_SPONSOR_BUDGET', 'Daily gas sponsorship exhausted', 409);
    const nonce = await this.chain.client.getTransactionCount({address:account.address,blockTag:'pending'});
    const data = encodeFunctionData({abi, functionName:'transfer',args:[target,this.topup]});
    const estimate = await this.chain.client.estimateGas({account:account.address,to:USDC,data,value:0n});
    const fees = await this.chain.client.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas! < MIN_FEE ? MIN_FEE : fees.maxFeePerGas!;
    requireThat(maxFeePerGas <= MAX_FEE, 'GAS_FEE_LIMIT', 'Gas fee ceiling exceeded', 503);
    const raw = await account.signTransaction({type:'eip1559',chainId:this.chain.chainId,to:USDC,data,value:0n,nonce,
      gas:estimate + estimate/5n,maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas ?? 0n});
    const hash = keccak256(raw), operation = `gas:${nonce}:${hash}`;
    this.keys.db.prepare('INSERT INTO gas_topups(operation,scope,recipient,day,amount,nonce,hash,raw) VALUES(?,?,?,?,?,?,?,?)')
      .run(operation,scope,target.toLowerCase(),day,String(this.topup),nonce,hash,raw);
    await this.keys.flush();
    await this.broadcast(operation,raw,hash);
    this.checked.set(scope,Date.now());
  }
  private async broadcast(operation: string, raw: Hex, hash: Hex) {
    let receipt;
    try { receipt = await this.chain.client.getTransactionReceipt({hash}); } catch { /* Pending is retried with identical bytes. */ }
    if (!receipt) {
      await this.chain.client.sendRawTransaction({serializedTransaction:raw});
      receipt = await this.chain.client.waitForTransactionReceipt({hash,timeout:20000});
    }
    requireThat(receipt.status === 'success', 'GAS_TOPUP_FAILED', 'Gas sponsorship transfer failed', 503);
    this.keys.db.prepare('UPDATE gas_topups SET confirmed=1 WHERE operation=?').run(operation);
    await this.keys.flush();
  }
}
