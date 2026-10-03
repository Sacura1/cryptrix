import { randomUUID } from 'node:crypto';
import { parseUsdc, type Action, type Equipment, type GameId } from './domain.js';
import type { TransactionIntent } from './chain.js';
import type { MiningCommand } from './mining.js';

interface Offer { id: string; game: GameId; mode: 'practice' | 'paid'; status: string; stake: string; filled: number; capacity: number; participants: { agentId: string; wallet: string }[] }
interface EnterResponse { match: Offer; fundingRequired: boolean; transactions: TransactionIntent[] }
// An external agent supplies its own signer. The SDK never asks for a private key.
export interface WalletAdapter { sendAndWait(transactions: TransactionIntent[], operationId: string): Promise<`0x${string}`> }
export class AgentClient {
  private readonly base: URL;
  constructor(baseUrl: string, private token: string, private wallet?: WalletAdapter) {
    this.base = new URL(baseUrl);
    if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('Supply a plain HTTP(S) API base URL.');
    this.base.pathname = this.base.pathname.replace(/\/$/, '') + '/';
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
    const response = await fetch(new URL(path.replace(/^\//, ''), this.base), {
      method, headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${value.error ?? response.status}: ${value.message ?? 'Request failed'}`);
    return value as T;
  }
  async openMatches(game: GameId) { return (await this.request<{ matches: Offer[] }>(`/matches?status=open&game=${game}&limit=100`)).matches; }
  async currentMatches() { return (await this.request<{ matches: Offer[] }>('/runtime/matches')).matches; }
  async observation(id: string) { return this.request<{ status: string; version?: number; nextSequence?: number; nextRound: number; actionLocked: boolean; roundDeadline: number; observation: unknown }>(`/runtime/matches/${id}/observation`); }
  async revealEquipment(id: string, equipment: Equipment, equipmentSalt?: string) { return this.request(`/runtime/matches/${id}/equipment`, 'POST', { equipment, equipmentSalt }); }
  async act(id: string, round: number, action: Action) { return this.request(`/runtime/matches/${id}/actions`, 'POST', { round, action }, `action:${id}:${round}`); }
  async command(id: string, sequence: number, command: MiningCommand) { return this.request(`/runtime/matches/${id}/commands`, 'POST', { sequence, command }, `mining:${id}:${sequence}`); }
  async findOrCreate(game: GameId, preferredStake: string, accept: (offer: Offer) => boolean = offer => parseUsdc(offer.stake) === parseUsdc(preferredStake)) {
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
    // Owner/agent filters and stake limits are also checked by the API and wallet.
    const offer = offers.find(accept);
    const result = offer ? await this.request<EnterResponse>(`/runtime/matches/${offer.id}/join`, 'POST', { expectedStake: offer.stake }, randomUUID()) : await this.request<EnterResponse>('/runtime/matches', 'POST', { game, stake: game === 'cache-rush' ? '1' : preferredStake }, randomUUID());
    if (result.fundingRequired) {
      // Retain intent and transaction hash in a real runtime's durable job store before retrying.
      const transactionHash = await this.wallet!.sendAndWait(result.transactions, result.match.id);
      await this.request(`/runtime/matches/${result.match.id}/confirm`, 'POST', { transactionHash });
    }
    return result.match;
  }
}
