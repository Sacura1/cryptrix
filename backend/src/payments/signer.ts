import { getAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { ArcGateway } from '../chain.js';
import { requireThat } from '../domain.js';

export interface UnsignedTransaction { chainId: number; to: string; data: Hex; value: '0'; nonce: number; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string }
export interface SigningContext { purpose: 'settlement' | 'refund' | 'claim'; matchId: string; agentId?: string; resultHash?: string; replay?: unknown }
export interface RemoteSigningProvider {
  address(scope: string): Promise<Address>;
  sign(scope: string, operationId: string, transaction: UnsignedTransaction, context: SigningContext): Promise<Hex>;
}
export const MAX_GAS = 500_000n;
export const MIN_FEE = 20_000_000_000n;
export const MAX_FEE = 100_000_000_000n;
export const MAX_GAS_PER_DAY = 1_000_000_000_000_000_000n; // One USDC in the native 18-decimal view; paid by the service key.

export class HttpSigningProvider implements RemoteSigningProvider {
  private readonly base: URL;
  constructor(url: string, private readonly token: string, private readonly request: typeof fetch = fetch) {
    this.base = new URL(url);
    requireThat(this.base.protocol === 'https:' || (this.base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(this.base.hostname)), 'SIGNER_TRANSPORT', 'Signer transport must use HTTPS or local loopback HTTP.', 503);
    requireThat(!this.base.username && !this.base.password && token.length >= 16, 'SIGNER_CONFIG', 'Configure a separate signer service credential.', 503);
  }
  private async json(path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(new URL(path, this.base), { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('SIGNER_UNAVAILABLE'); }
    const reader = response.body?.getReader(); requireThat(reader, 'SIGNER_RESPONSE', 'Signer returned an empty response.', 503);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; requireThat(size <= 131_072, 'SIGNER_RESPONSE', 'Signer response exceeded the limit.', 503); chunks.push(part.value); } }
    finally { await reader.cancel(); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async address(scope: string) { return getAddress(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(await this.json(`/v1/keys/${encodeURIComponent(scope)}`)).address); }
  async sign(scope: string, operationId: string, transaction: UnsignedTransaction, context: SigningContext) {
    return z.object({ serializedTransaction: z.string().regex(/^0x[0-9a-fA-F]{2,131072}$/) }).parse(await this.json('/v1/transactions', { scope, operationId, transaction, context })).serializedTransaction as Hex;
  }
}
export class SigningService {
  constructor(readonly chain: ArcGateway, readonly provider: RemoteSigningProvider) {}
}

export async function validateSigned(raw: Hex, expected: UnsignedTransaction, signer: string) {
  const tx = parseTransaction(raw);
  // RLP encodes a zero priority fee as an empty value; viem parses it as absent.
  const priorityFee = tx.maxPriorityFeePerGas ?? 0n;
  requireThat(tx.type === 'eip1559' && tx.chainId === expected.chainId && tx.to?.toLowerCase() === expected.to.toLowerCase() && (tx.data ?? '0x').toLowerCase() === expected.data.toLowerCase() && (tx.value ?? 0n) === 0n && tx.nonce === expected.nonce, 'SIGNED_TRANSACTION_CHANGED', 'Signer changed the authorised transaction.', 503);
  requireThat(tx.gas === BigInt(expected.gas) && tx.gas > 0n && tx.gas <= MAX_GAS && tx.maxFeePerGas === BigInt(expected.maxFeePerGas) && priorityFee === BigInt(expected.maxPriorityFeePerGas) && tx.maxFeePerGas >= MIN_FEE && tx.maxFeePerGas <= MAX_FEE && priorityFee >= 0n && priorityFee <= tx.maxFeePerGas && (tx.accessList?.length ?? 0) === 0, 'SIGNED_FEE_LIMIT', 'Signer changed fees or exceeded the gas ceiling.', 503);
  const recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
  requireThat(recovered.toLowerCase() === signer.toLowerCase(), 'WRONG_SIGNER', 'Transaction was signed by a different key.', 503);
  return { hash: keccak256(raw), sender: recovered.toLowerCase(), nonce: tx.nonce };
}
