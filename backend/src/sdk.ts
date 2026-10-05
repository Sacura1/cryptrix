import { randomUUID } from 'node:crypto';
import { parseUsdc, type Action, type Equipment, type GameId } from './domain.js';
import type { TransactionIntent } from './chain.js';
import type { MiningCommand } from './mining.js';

interface Offer { id: string; title?: string; game: GameId; mode: 'practice' | 'paid'; status: string; stake: string; filled: number; capacity: number; participants: { agentId: string; wallet: string }[] }
interface EnterResponse { match: Offer; fundingRequired: boolean; transactions: TransactionIntent[] }
// An external agent supplies its own signer. The SDK never asks for a private key.
export interface WalletAdapter {
  address: string;
  signMessage(message: string): Promise<`0x${string}`>;
  // Persist signed bytes/receipts per operationId before broadcasting. Retries must reuse them.
  sendAndWait(transactions: TransactionIntent[], operationId: string): Promise<`0x${string}`>;
}
export class AgentApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: any) { super(message); }
}
export class AgentClient {
  private readonly base: URL;
  private expiresAt = 0;
  constructor(baseUrl: string, private token: string, private wallet?: WalletAdapter) {
    this.base = new URL(baseUrl);
    if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('Supply a plain HTTP(S) API base URL.');
    this.base.pathname = this.base.pathname.replace(/\/$/, '') + '/';
  }
  static async connect(baseUrl: string, wallet: WalletAdapter) {
    const client = new AgentClient(baseUrl, '', wallet);
    await client.authenticate(); return client;
  }
  async authenticate() {
    if (!this.wallet) throw new Error('Authentication requires an external wallet adapter.');
    const challenge = await this.request<{ challengeId: string; message: string }>('/auth/challenge', 'POST', { wallet: this.wallet.address });
    const signature = await this.wallet.signMessage(challenge.message);
    const result = await this.request<{ token: string; expiresAt: number }>('/auth/verify', 'POST', { challengeId: challenge.challengeId, signature });
    this.token = result.token; this.expiresAt = result.expiresAt;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!path.startsWith('/auth/') && this.wallet && this.expiresAt && this.expiresAt <= Date.now() + 60_000) await this.authenticate();
    const response = await fetch(new URL(path.replace(/^\//, ''), this.base), {
      method, headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json();
    if (!response.ok) throw new AgentApiError(response.status, value.error ?? String(response.status), value.message ?? 'Request failed', value.details);
    return value as T;
  }
  async openMatches(game: GameId) { return (await this.request<{ matches: Offer[] }>(`/matches?status=open&game=${game}&limit=100`)).matches; }
  async currentMatches() { return (await this.request<{ matches: Offer[] }>('/runtime/matches')).matches; }
  async me() { return this.request<{ id: string; wallet: string; name: string }>('/runtime/me'); }
  async rules() { return this.request('/games'); }
  async result(id: string) { return this.request(`/matches/${id}`); }
  async walletStatus() { return this.request<{ claimableUsdc: string; transaction: TransactionIntent }>('/runtime/wallet'); }
  async claim(operationId: string) {
    if (!this.wallet) throw new Error('Claims require your wallet adapter.');
    const status = await this.walletStatus();
    if (parseUsdc(status.claimableUsdc) === 0) return null;
    return this.wallet.sendAndWait([status.transaction], operationId);
  }
  async refund(id: string, operationId: string) {
    if (!this.wallet) throw new Error('Refunds require your wallet adapter.');
    const { transaction } = await this.request<{ transaction: TransactionIntent }>(`/runtime/matches/${id}/refund`);
    return this.wallet.sendAndWait([transaction], operationId);
  }
  async observation(id: string) { return this.request<{ status: string; version?: number; nextSequence?: number; nextRound: number; actionLocked: boolean; roundDeadline: number; observation: unknown }>(`/runtime/matches/${id}/observation`); }
  async revealEquipment(id: string, equipment: Equipment, equipmentSalt?: string) { return this.request(`/runtime/matches/${id}/equipment`, 'POST', { equipment, equipmentSalt }); }
  async act(id: string, round: number, action: Action) { return this.request(`/runtime/matches/${id}/actions`, 'POST', { round, action }, `action:${id}:${round}`); }
  async command(id: string, sequence: number, command: MiningCommand) { return this.request(`/runtime/matches/${id}/commands`, 'POST', { sequence, command }, `mining:${id}:${sequence}`); }
  async findOrCreate(game: GameId, preferredStake: string, accept: (offer: Offer) => boolean = offer => parseUsdc(offer.stake) === parseUsdc(preferredStake), options: { title?: string } = {}) {
    const current = await this.currentMatches();
    const health = await this.request<{ mode: string }>('/health');
    if (health.mode === 'paid' && !this.wallet) throw new Error('Paid entries require your own wallet adapter. No entry intent was created.');
    if (current.length) {
      const match = current[0]!;
      if (health.mode === 'paid' && (match.status === 'funding' || match.status === 'open')) {
        // The wallet adapter must persist receipts under operationId, so resuming never pays twice.
        const me = await this.request<{ id: string }>('/runtime/me');
        if (!match.participants.some(p => p.agentId === me.id)) {
          const pending = await this.request<EnterResponse>(`/runtime/matches/${match.id}/entry-intent`);
          const transactionHash = await this.wallet!.sendAndWait(pending.transactions, match.id);
          await this.request(`/runtime/matches/${match.id}/confirm`, 'POST', { transactionHash });
        }
      }
      return match;
    }
    const offers = await this.openMatches(game);
    // Wallet availability and stake limits are also checked by the API and wallet.
    const offer = offers.find(accept);
    const result = offer ? await this.request<EnterResponse>(`/runtime/matches/${offer.id}/join`, 'POST', { expectedStake: offer.stake }, randomUUID()) : await this.request<EnterResponse>('/runtime/matches', 'POST', { game, stake: preferredStake, title: options.title }, randomUUID());
    if (result.fundingRequired) {
      // Retain intent and transaction hash in a real runtime's durable job store before retrying.
      const transactionHash = await this.wallet!.sendAndWait(result.transactions, result.match.id);
      await this.request(`/runtime/matches/${result.match.id}/confirm`, 'POST', { transactionHash });
    }
    return result.match;
  }
}
