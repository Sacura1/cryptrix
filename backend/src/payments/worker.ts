import { randomUUID } from 'node:crypto';
import { getAddress, parseAbi, type Address, type Hex } from 'viem';
import { digest, Fault, formatUsdc, readEquipmentIntent, requireThat, type Match } from '../domain.js';
import { USDC, type ArcGateway, type TransactionIntent } from '../chain.js';
import { Platform } from '../platform.js';
import { replayData, verifyResult } from '../replay.js';
import { MAX_FEE, MAX_GAS, MAX_GAS_PER_DAY, MIN_FEE, SigningService, validateSigned, type SigningContext, type UnsignedTransaction } from './signer.js';

interface Payload { matchId: string; agentId?: string; scope: string; context: SigningContext; intent: TransactionIntent; deadline: number }
interface Job { key: string; kind: string; payload: string; status: string; raw_tx: Hex | null; unsigned_tx: string | null; sender: string | null; nonce: number | null; hash: Hex | null; attempts: number; lease_token: string }
export class PaymentWorker {
  private running = false;
  private closing = false;
  private task?: Promise<void>;
  private reconcileAt = 0;
  private reconcileCursor = 0;
  constructor(readonly platform: Platform, readonly signer: SigningService) {}
  get chain(): ArcGateway { return this.signer.chain; }
  async runOnce() {
    if (this.running || this.closing) return;
    this.running = true;
    this.task = this.batch().finally(() => { this.running = false; });
    await this.task;
  }
  private async batch() {
    const { store, now } = this.platform;
    // Older workers parked fresh, never-signed claims when an RPC nonce lagged.
    // Only these harmless reservations may be resumed automatically.
    const recovered = store.db.prepare("UPDATE jobs SET status='retry',next_at=0,error=NULL WHERE kind='claim' AND status='needs-review' AND error='NONCE_CONFLICT' AND unsigned_tx IS NULL AND raw_tx IS NULL AND hash IS NULL AND lease_until<=?").run(now());
    if (recovered.changes) store.audit('claim-nonce-recovered', 'payments', { count: Number(recovered.changes) }, now());
    const resumed = store.db.prepare("UPDATE jobs SET status='retry',next_at=0,error=NULL WHERE kind='claim' AND status='done' AND unsigned_tx IS NOT NULL AND raw_tx IS NOT NULL AND hash IS NOT NULL AND lease_until<=?").run(now());
    if (resumed.changes) store.audit('claim-receipt-resumed', 'payments', { count: Number(resumed.changes) }, now());
    // Exhaustive pending query; never silently omit settlements after the first 100 results.
    const finished = store.db.prepare("SELECT doc FROM matches WHERE mode='paid' AND status='finished'").all().map(row => JSON.parse(String(row.doc)) as Match);
    for (const match of finished.filter(m => m.settlement === 'pending')) {
      try {
        verifyResult(match);
        store.enqueue(`settlement:${match.id}`, 'settlement', { matchId: match.id, scope: 'resolver', context: { purpose: 'settlement', matchId: match.id, resultHash: match.resultHash, replay: replayData(match) }, intent: this.chain.settlement(match), deadline: match.chainResolveDeadline ?? 0 }, now());
      } catch { store.service('settlement', now(), 'REPLAY_INVALID'); }
    }
    // Claiming cannot withdraw to the platform: the immutable account receives all credits.
    const claimable = store.db.prepare("SELECT doc FROM matches WHERE mode='paid' AND (status='finished' OR status='cancelled')").all().map(row => JSON.parse(String(row.doc)) as Match);
    const agents = new Map(store.agents().map(agent => [agent.wallet.toLowerCase(), agent]));
    const candidates = new Map<string, Payload>();
    for (const match of claimable.filter(m => m.settlement === 'settled' || m.settlement === 'refund-claimable')) for (const wallet of match.chainParticipants ?? match.entries.map(e => e.wallet)) {
      const agent = agents.get(wallet.toLowerCase()); if (!agent) continue;
      if (match.settlement === 'settled' && !match.payouts?.[match.entries.findIndex(e => e.wallet.toLowerCase() === wallet.toLowerCase())]) continue;
      const payload: Payload = { matchId: match.id, agentId: agent.id, scope: 'keeper', context: { purpose: 'claim', matchId: match.id, agentId: agent.id }, intent: this.chain.claimAccount(agent.wallet), deadline: 0 };
      store.enqueue(`claim:${match.id}:${agent.id}`, 'claim', payload, now());
      candidates.set(agent.id, payload);
    }
    await this.reconcileClaims([...candidates.values()]);
    // Deadline refunds are permissionless. Keeper pays fees from its own service wallet.
    for (const match of store.db.prepare("SELECT doc FROM matches WHERE mode='paid'").all().map(row => JSON.parse(String(row.doc)) as Match).filter(m => (m.chainStatus === 1 && m.fillDeadline <= now()) || (m.chainStatus === 2 && !!m.chainResolveDeadline && m.chainResolveDeadline <= now()))) {
      store.enqueue(`refund:${match.id}`, 'refund', { matchId: match.id, scope: 'keeper', context: { purpose: 'refund', matchId: match.id }, intent: this.chain.refund(match.id), deadline: 0 }, now());
    }
    for (let i = 0; i < 8 && !this.closing; i++) {
      const job = store.transaction(() => {
        const row = store.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','retry','broadcast','paused','running') AND next_at<=? AND lease_until<=? ORDER BY CASE WHEN unsigned_tx IS NOT NULL THEN 0 ELSE 1 END,CASE kind WHEN 'refund' THEN 0 WHEN 'settlement' THEN 1 WHEN 'claim' THEN 2 ELSE 3 END,created_at,key LIMIT 1").get(now(), now()) as unknown as Job | undefined;
        if (!row) return;
        const token = randomUUID();
        store.db.prepare("UPDATE jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE key=?").run(token, now() + 120_000, now(), row.key);
        return { ...row, lease_token: token, attempts: row.attempts + 1 };
      });
      if (!job) break;
      try { await this.execute(job); store.service('payments', now()); }
      catch (error) {
        const code = error instanceof Fault ? error.code : 'PAYMENT_RETRY';
        const review = ['SIGNED_TRANSACTION_CHANGED', 'SIGNED_FEE_LIMIT', 'WRONG_SIGNER', 'NONCE_CONFLICT', 'REPLAY_INVALID', 'SETTLEMENT_MISMATCH', 'OPERATION_EXPIRED'].includes(code);
        this.update(job, review ? 'needs-review' : 'retry', code, code === 'NONCE_BUSY' ? 1000 : Math.min(300_000, 2000 * 2 ** Math.min(job.attempts, 7)));
        store.service('payments', now(), code);
      }
    }
  }
  private async reconcileClaims(candidates: Payload[]) {
    const { store, now } = this.platform;
    if (now() < this.reconcileAt || !candidates.length) return;
    this.reconcileAt = now() + 30_000;
    // Bounded round robin also rechecks jobs that once saw zero or mined a revert.
    for (let i = 0; i < Math.min(8, candidates.length) && !this.closing; i++) {
      const payload = candidates[this.reconcileCursor++ % candidates.length]!;
      try {
        const jobs = store.db.prepare("SELECT * FROM jobs WHERE kind='claim' AND json_extract(payload,'$.agentId')=? ORDER BY created_at DESC,rowid DESC").all(payload.agentId!) as unknown as Job[];
        if (!jobs.length || jobs.some(job => !['done', 'confirmed', 'failed'].includes(job.status))) continue;
        const previous = jobs[0]!;
        if (previous.status === 'done' && previous.hash) {
          // A legacy zero-credit shortcut might have left signed bytes outstanding.
          let receipt;
          try { receipt = await this.chain.client.getTransactionReceipt({ hash: previous.hash }); } catch {}
          if (!receipt) {
            store.db.prepare("UPDATE jobs SET status='retry',next_at=0,error=NULL WHERE key=?").run(previous.key);
            continue;
          }
        }
        const credit = await this.chain.client.readContract({ address: this.chain.escrow, abi: parseAbi(['function credits(address) view returns (uint256)']), functionName: 'credits', args: [getAddress(store.agent(payload.agentId!).wallet)] });
        if (credit === 0n) continue;
        // A new operation ID preserves every prior signature, receipt and nonce.
        const key = `claim-recovery:${digest(previous.key)}`;
        store.enqueue(key, 'claim', payload, now());
        store.audit('claim-credit-recovered', key, { previous: previous.key }, now());
      } catch { store.service('claim-reconciliation', now(), 'CLAIM_CHECK_RETRY'); }
    }
  }
  private live(job: Job) {
    const row = this.platform.store.db.prepare('SELECT lease_token,lease_until FROM jobs WHERE key=?').get(job.key);
    requireThat(row?.lease_token === job.lease_token && Number(row.lease_until) > this.platform.now(), 'JOB_LEASE_LOST', 'A stale payment worker cannot write this operation.', 409);
  }
  private update(job: Job, status: string, error?: string, delay = 0) {
    const { store, now } = this.platform;
    store.db.prepare('UPDATE jobs SET status=?,error=?,next_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE key=? AND lease_token=?').run(status, error ?? null, now() + delay, now(), job.key, job.lease_token);
    store.audit('payment-state', job.key, { status, error: error ?? null }, now());
  }
  private async execute(job: Job) {
    const { store, now } = this.platform;
    const payload = JSON.parse(job.payload) as Payload;
    const match = store.match(payload.matchId);
    if (job.hash) {
      let receipt;
      try { receipt = await this.chain.client.getTransactionReceipt({ hash: job.hash }); } catch { /* Identical bytes can be retried; never make a second signature. */ }
      if (receipt) {
        if (receipt.status === 'reverted') { this.update(job, 'failed', 'TRANSACTION_REVERTED'); return; }
        await this.platform.sync(match.id);
        if (job.kind === 'refund') requireThat(store.match(match.id).chainStatus === 4, 'REFUND_UNCONFIRMED', 'Refund receipt did not produce cancellation.');
        if (job.kind === 'settlement') requireThat(store.match(match.id).settlement === 'settled', 'SETTLEMENT_UNCONFIRMED', 'Settlement is not confirmed.');
        this.update(job, 'confirmed'); return;
      }
    }
    if ((job.kind === 'settlement' && match.settlement === 'settled') || (job.kind === 'refund' && match.chainStatus === 4)) { this.update(job, 'confirmed'); return; }
    if (payload.deadline > 0 && payload.deadline <= now()) { this.update(job, job.raw_tx || job.unsigned_tx ? 'needs-review' : 'expired', 'OPERATION_EXPIRED'); return; }
    if (match.status === 'cancelled' && job.kind !== 'refund' && job.kind !== 'claim') { this.update(job, job.unsigned_tx ? 'needs-review' : 'cancelled', 'MATCH_CANCELLED'); return; }
    if (job.kind === 'claim' && !job.unsigned_tx) {
      const credit = await this.chain.client.readContract({ address: this.chain.escrow, abi: parseAbi(['function credits(address) view returns (uint256)']), functionName: 'credits', args: [getAddress(store.agent(payload.agentId!).wallet)] });
      if (credit === 0n) { this.update(job, 'done'); return; }
    }
    const sender = await this.signer.provider.address(payload.scope);
    if (job.kind === 'settlement') { verifyResult(match); requireThat(sender.toLowerCase() === this.chain.resolver?.toLowerCase(), 'WRONG_SIGNER', 'Only the configured escrow resolver can settle.', 503); }
    if (this.closing) { this.update(job, 'retry', 'SHUTDOWN', 1000); return; }
    let unsigned: UnsignedTransaction;
    if (job.unsigned_tx) {
      unsigned = JSON.parse(job.unsigned_tx) as UnsignedTransaction;
      requireThat(job.sender === sender.toLowerCase(), 'WRONG_SIGNER', 'Key changed while a signed operation may be outstanding.', 409);
    } else {
      const outstanding = store.db.prepare("SELECT key FROM jobs WHERE sender=? AND unsigned_tx IS NOT NULL AND status NOT IN ('confirmed','failed','done') AND key<>? LIMIT 1").get(sender.toLowerCase(), job.key);
      if (outstanding) { this.update(job, 'retry', 'SIGNER_BUSY', 1000); return; }
      const nonce = await this.chain.client.getTransactionCount({ address: sender, blockTag: 'pending' });
      const estimate = await this.chain.client.estimateGas({ account: sender, to: getAddress(payload.intent.to), data: payload.intent.data, value: 0n });
      const gas = estimate + estimate / 5n;
      requireThat(gas <= MAX_GAS, 'GAS_LIMIT', 'Gas estimate exceeds the service ceiling.', 503);
      const fees = await this.chain.client.estimateFeesPerGas();
      const fee = fees.maxFeePerGas! < MIN_FEE ? MIN_FEE : fees.maxFeePerGas!;
      requireThat(fee <= MAX_FEE, 'FEE_LIMIT', 'Arc fees exceed the service ceiling.', 503);
      unsigned = { chainId: this.chain.chainId, to: payload.intent.to, data: payload.intent.data, value: '0', nonce, gas: String(gas), maxFeePerGas: String(fee), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas ?? 0n) };
      store.transaction(() => {
        this.live(job);
        const address = sender.toLowerCase();
        const prior = store.db.prepare('SELECT key FROM jobs WHERE sender=? AND nonce=? AND unsigned_tx IS NOT NULL AND key<>?').get(address, nonce, job.key);
        requireThat(!prior, 'NONCE_BUSY', 'RPC nonce has not advanced past the prior durable operation. Retry after confirmation.', 409);
        const day = Math.floor(now() / 86_400_000);
        const reserved = store.db.prepare('SELECT reserved_gas FROM jobs WHERE sender=? AND fee_day=?').all(address, day).reduce((sum, row) => sum + BigInt(String(row.reserved_gas ?? '0')), 0n);
        requireThat(reserved + gas * fee <= MAX_GAS_PER_DAY, 'GAS_BUDGET', 'Daily service-key fee reservation exhausted.', 409);
        store.db.prepare('UPDATE jobs SET unsigned_tx=?,sender=?,nonce=?,reserved_gas=?,fee_day=? WHERE key=? AND lease_token=?').run(JSON.stringify(unsigned), address, nonce, String(gas * fee), day, job.key, job.lease_token);
      });
    }
    let raw = job.raw_tx;
    if (!raw) {
      await store.flush();
      raw = await this.signer.provider.sign(payload.scope, job.key, unsigned, payload.context);
      const checked = await validateSigned(raw, unsigned, sender);
      this.live(job);
      store.db.prepare('UPDATE jobs SET raw_tx=?,hash=? WHERE key=? AND lease_token=?').run(raw, checked.hash, job.key, job.lease_token);
      job.hash = checked.hash;
    } else await validateSigned(raw, unsigned, sender);
    if (this.closing) { this.update(job, 'retry', 'SHUTDOWN', 1000); return; }
    this.live(job);
    requireThat(!payload.deadline || payload.deadline > now(), 'OPERATION_EXPIRED', 'Signing finished after the operation deadline.', 409);
    await store.flush();
    const hash = await this.chain.client.sendRawTransaction({ serializedTransaction: raw });
    requireThat(hash.toLowerCase() === job.hash!.toLowerCase(), 'SIGNED_TRANSACTION_CHANGED', 'RPC returned a different transaction hash.', 503);
    this.update(job, 'broadcast', undefined, 1000);
  }
  async stop() { this.closing = true; await this.task; }
}
