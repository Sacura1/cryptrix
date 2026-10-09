import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicClient, createWalletClient, decodeFunctionData, getAddress, http, keccak256, parseAbi, type Chain, type Hex, type PrivateKeyAccount } from 'viem';
import { arc, arcTestnet } from 'viem/chains';
import { escrowAbi, USDC, type TransactionIntent } from '../src/chain.js';
import type { WalletAdapter } from '../src/sdk.js';

const approvalAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
/** Example for one external agent process. Keep the journal private and use one writer per wallet. */
export class ArcWalletAdapter implements WalletAdapter {
  readonly address: string;
  readonly chainId: number;
  readonly client;
  readonly wallet;
  constructor(readonly account: PrivateKeyAccount, readonly escrow: string, readonly journalPath: string, rpc?: string, readonly maxStake = 5_000_000n, network: 'mainnet' | 'testnet' = 'testnet') {
    const chain: Chain = network === 'mainnet' ? arc : arcTestnet;
    this.chainId = chain.id;
    this.address = account.address;
    this.client = createPublicClient({ chain, transport: http(rpc, { retryCount: 1 }) });
    this.wallet = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 0 }) });
  }
  signMessage(message: string) { return this.account.signMessage({ message }); }
  async sendAndWait(transactions: TransactionIntent[], operationId: string): Promise<Hex> {
    if (await this.client.getChainId() !== this.chainId) throw new Error('Wrong network');
    mkdirSync(dirname(this.journalPath), { recursive: true });
    const journal = existsSync(this.journalPath) ? JSON.parse(readFileSync(this.journalPath, 'utf8')) : {};
    const save = () => { const temp = `${this.journalPath}.tmp`; writeFileSync(temp, JSON.stringify(journal), { mode: 0o600 }); renameSync(temp, this.journalPath); };
    let last: Hex | undefined;
    for (const [index, tx] of transactions.entries()) {
      if (tx.chainId !== this.chainId || tx.value !== '0') throw new Error('Invalid transaction terms');
      if (tx.amountUnits && (BigInt(tx.amountUnits) < 500_000n || BigInt(tx.amountUnits) > this.maxStake || (BigInt(tx.amountUnits) !== 500_000n && BigInt(tx.amountUnits) % 1_000_000n !== 0n))) throw new Error('Stake outside wallet policy');
      if (tx.to.toLowerCase() === USDC.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: approvalAbi, data: tx.data });
        if (decoded.args[0].toLowerCase() !== this.escrow.toLowerCase() || decoded.args[1] !== BigInt(tx.amountUnits ?? '0')) throw new Error('Approval changed');
      } else {
        if (tx.to.toLowerCase() !== this.escrow.toLowerCase()) throw new Error('Unexpected contract');
        const decoded = decodeFunctionData({ abi: escrowAbi, data: tx.data });
        if (!['createMatchWithEquipment','joinMatchWithEquipment','claimFor','cancelExpired'].includes(decoded.functionName)) throw new Error('Unexpected method');
        const args = decoded.args as readonly any[];
        if (decoded.functionName === 'claimFor' && args[0].toLowerCase() !== this.address.toLowerCase()) throw new Error('Unexpected claim beneficiary');
        if (decoded.functionName === 'createMatchWithEquipment' && args[2] !== BigInt(tx.amountUnits ?? '0')) throw new Error('Create stake changed');
        if (decoded.functionName === 'joinMatchWithEquipment' && args[1] !== BigInt(tx.amountUnits ?? '0')) throw new Error('Join stake changed');
      }
      const key = `${operationId}:${index}`, fingerprint = JSON.stringify(tx);
      let saved = journal[key];
      if (saved && saved.fingerprint !== fingerprint) throw new Error('Operation changed; inspect saved receipt');
      if (!saved) {
        const fees = await this.client.estimateFeesPerGas();
        const maxFeePerGas = fees.maxFeePerGas! < 20_000_000_000n ? 20_000_000_000n : fees.maxFeePerGas!;
        if (maxFeePerGas > 100_000_000_000n) throw new Error('Fee ceiling');
        const gas = await this.client.estimateGas({ account: this.account.address, to: getAddress(tx.to), data: tx.data, value: 0n });
        const request = await this.wallet.prepareTransactionRequest({ to: getAddress(tx.to), data: tx.data, value: 0n, gas: gas+gas/5n, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n, type:'eip1559' });
        const raw = await this.wallet.signTransaction(request);
        journal[key] = saved = { fingerprint, raw, hash: keccak256(raw) }; save();
      }
      let receipt;
      try { receipt = await this.client.getTransactionReceipt({ hash: saved.hash }); } catch { /* signed bytes can safely be retried */ }
      if (!receipt) {
        try { await this.client.sendRawTransaction({ serializedTransaction: saved.raw }); } catch { /* receipt resolves already-broadcast transactions */ }
        receipt = await this.client.waitForTransactionReceipt({ hash: saved.hash, timeout: 60000 });
      }
      if (receipt.status !== 'success') throw new Error('Entry reverted; inspect the room before a new operation');
      saved.confirmed = true; save(); last = saved.hash;
    }
    if (!last) throw new Error('Empty transaction plan');
    return last;
  }
}
// Preserve the original testnet example import for existing local clients.
export { ArcWalletAdapter as TestnetWalletAdapter };
