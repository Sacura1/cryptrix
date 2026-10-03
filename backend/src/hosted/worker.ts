import { modelFailure } from './errors.js';
import { randomUUID } from 'node:crypto';
import { type Action, type Match } from '../domain.js';
import { actionSchema, validateAction } from '../engine.js';
import { Platform } from '../platform.js';
import { miningCommandSchema, validateMining, type MiningCommand } from '../mining.js';
import { allowanceFor, DAILY_MODEL_ALLOWANCE, DAILY_MODEL_REQUESTS, DECISION_MS, decisionRequest, MAX_PROMPT_BYTES, MEMORY_CHARS, type DecisionProvider, type DecisionRequest, type DecisionResult } from './provider.js';

interface Job { id: string; match_id: string; agent_id: string; round: number; lease_until: number; status: string }
interface Claim { job: Job; request: DecisionRequest; day: number; timeout: number }

export class HostedWorker {
  private readonly running = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private closing = false;
  private readonly lastDispatch = new Map<string, number>();
  constructor(readonly platform: Platform, private readonly provider: DecisionProvider, readonly concurrency = 8, private readonly matchScope?: ReadonlySet<string>) {
    if (platform.hostedMode !== 'model') throw new Error('Hosted worker requires model mode; strategy bots must be disabled.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('Hosted concurrency must be 1–64.');
  }
  // One bounded batch. The server clock runs independently while requests are in flight.
  async runOnce(): Promise<void> {
    if (this.closing) return;
    const { store, now } = this.platform;
    const expired = store.db.prepare("SELECT * FROM model_jobs WHERE status='running' AND lease_until<=?").all(now()) as unknown as Job[];
    for (const job of expired) { if (this.matchScope && !this.matchScope.has(job.match_id)) continue; this.running.get(job.id)?.controller.abort('deadline'); this.finish(job, undefined, 'interrupted'); }
    for (const match of store.outstanding().filter(m => m.status === 'active' && (!this.matchScope || this.matchScope.has(m.id))).sort((a, b) => Math.min(...a.entries.map(e => this.lastDispatch.get(e.agentId) ?? 0)) - Math.min(...b.entries.map(e => this.lastDispatch.get(e.agentId) ?? 0)) || a.createdAt - b.createdAt)) {
      for (const entry of match.entries.slice().sort((a,b) => (this.lastDispatch.get(a.agentId) ?? 0) - (this.lastDispatch.get(b.agentId) ?? 0))) {
        if (this.closing || this.running.size >= this.concurrency) break;
        if (match.mining) {
          const player = match.mining.world.players.find(p => p.id === entry.agentId);
          if (!player?.alive || player.job || player.sequence >= 20 || player.nextDecisionAt > match.mining.world.elapsedMs) continue;
          if (store.db.prepare('SELECT 1 FROM model_jobs WHERE match_id=? AND agent_id=? AND round=?').get(match.id, entry.agentId, player.sequence + 1)) continue;
        }
        if (store.agent(entry.agentId).kind !== 'hosted') continue;
        const claim = this.claim(match.id, entry.agentId);
        if (!claim) continue;
        this.lastDispatch.set(entry.agentId, now());
        const controller = new AbortController();
        // Start after installing the slot so synchronous mock providers cannot escape the cap.
        const work = Promise.resolve().then(() => this.execute(claim, controller)).finally(() => this.running.delete(claim.job.id));
        this.running.set(claim.job.id, { controller, work });
      }
    }
    await Promise.all([...this.running.values()].map(task => task.work));
  }
  private claim(matchId: string, agentId: string): Claim | undefined {
    const { store, now } = this.platform;
    let immediate: { job: Job; reason: string } | undefined;
    const claim = store.transaction(() => {
      const startedAt = now();
      const match = store.match(matchId);
      const view = this.platform.observe(agentId, matchId);
      if (match.status !== 'active' || view.actionLocked || (!match.state && !match.mining)) return;
      const round = view.nextRound!;
      if (store.db.prepare('SELECT 1 FROM model_jobs WHERE match_id=? AND agent_id=? AND round=?').get(matchId, agentId, round)) return;
      const previous = store.db.prepare("SELECT memory FROM model_jobs WHERE match_id=? AND agent_id=? AND outcome='accepted' ORDER BY round DESC LIMIT 1").get(matchId, agentId);
      const request = decisionRequest(match.game, store.agent(agentId), view, String(previous?.memory ?? ''));
      const timeout = Math.min(DECISION_MS, match.roundDeadline! - startedAt - 250);
      const day = Math.floor(startedAt / 86_400_000), cost = allowanceFor(request);
      const used = store.usage(agentId, match.mode, startedAt);
      const allowance = Number(store.db.prepare('SELECT allowance FROM model_usage WHERE agent_id=? AND day=? AND mode=?').get(agentId, day, match.mode)?.allowance ?? 0);
      const reason = timeout <= 0 || (match.mining && timeout < DECISION_MS) ? 'deadline' : Buffer.byteLength(JSON.stringify(request)) > MAX_PROMPT_BYTES ? 'prompt-limit' : used.requests >= DAILY_MODEL_REQUESTS || allowance + cost > DAILY_MODEL_ALLOWANCE ? 'budget' : undefined;
      const job: Job = { id: randomUUID(), match_id: matchId, agent_id: agentId, round, lease_until: startedAt + Math.max(0, timeout), status: 'running' };
      store.db.prepare('INSERT INTO model_jobs(id,match_id,agent_id,round,lease_until,status) VALUES(?,?,?,?,?,?)').run(job.id, matchId, agentId, round, job.lease_until, job.status);
      if (reason) { immediate = { job, reason }; return; }
      // Write-ahead accounting: failed, aborted and uncertain calls still consume allowance.
      store.use(agentId, match.mode, startedAt, 0, 0, 1);
      store.db.prepare('INSERT INTO model_usage(agent_id,day,mode,allowance) VALUES(?,?,?,?) ON CONFLICT(agent_id,day,mode) DO UPDATE SET allowance=allowance+excluded.allowance').run(agentId, day, match.mode, cost);
      return { job, request, day, timeout };
    });
    if (immediate) this.finish(immediate.job, undefined, immediate.reason);
    return claim;
  }
  private async execute(claim: Claim, controller: AbortController): Promise<void> {
    if (controller.signal.aborted || this.closing) { this.finish(claim.job, undefined, 'shutdown'); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (this.platform.store.persistence) await this.platform.store.flush();
      if (controller.signal.aborted || this.closing) { this.finish(claim.job, undefined, 'shutdown'); return; }
      const remaining = claim.job.lease_until - this.platform.now();
      if (remaining <= 0) { this.finish(claim.job, undefined, 'deadline'); return; }
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('MODEL_ABORTED'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      timer = setTimeout(() => controller.abort('deadline'), remaining);
      const result = await Promise.race([this.provider.decide(claim.request, controller.signal), cancelled]);
      if (!Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0 || !Number.isSafeInteger(result.outputTokens) || result.outputTokens < 0 || result.outputTokens > claim.request.maxOutputTokens || typeof result.memory !== 'string' || result.memory.length > MEMORY_CHARS) throw new Error('MODEL_INVALID_RESULT');
      const { store } = this.platform;
      const match = store.match(claim.job.match_id);
      store.db.prepare('UPDATE model_usage SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE agent_id=? AND day=? AND mode=?').run(result.inputTokens, result.outputTokens, claim.job.agent_id, claim.day, match.mode);
      this.finish(claim.job, result, 'invalid-action');
    } catch (error) {
      this.finish(claim.job, undefined, this.closing ? 'shutdown' : modelFailure(error, controller.signal).reason);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
  private finish(job: Job, result: DecisionResult | undefined, reason: string): void {
    const { store, now } = this.platform;
    const current = store.db.prepare('SELECT status FROM model_jobs WHERE id=?').get(job.id);
    if (current?.status !== 'running') return;
    const match: Match = store.match(job.match_id);
    let outcome = 'discarded', memory = '';
    // Late output cannot become the next turn's decision or private memory.
    const observed = this.platform.observe(job.agent_id, match.id);
    if (!this.closing && match.status === 'active' && observed.nextRound === job.round && !observed.actionLocked && match.roundDeadline! > now()) {
      if (match.mining) {
        let command: MiningCommand = { type: 'wait' }; outcome = `fallback:${reason}`;
        if (result && job.lease_until > now()) {
          try { command = miningCommandSchema.parse(result.action); validateMining(match.mining.world, job.agent_id, job.round, command); memory = result.memory; outcome = 'accepted'; } catch { command = { type: 'wait' }; }
        }
        try { this.platform.command(job.agent_id, match.id, `hosted:${job.id}`, { sequence: job.round, command }); } catch { outcome = 'discarded'; memory = ''; }
      } else {
      let action: Action = { type: 'wait' };
      outcome = `fallback:${reason}`;
      if (result && job.lease_until > now()) {
        try { action = actionSchema.parse(result.action); validateAction(match.state!, job.agent_id, action); memory = result.memory; outcome = 'accepted'; }
        catch { action = { type: 'wait' }; }
      }
      // This call is synchronous; no other completion can interleave the round check and lock.
      this.platform.submit(job.agent_id, match.id, `hosted:${job.id}`, { round: job.round, action });
      }
    }
    store.db.prepare("UPDATE model_jobs SET status='done',outcome=?,memory=? WHERE id=? AND status='running'").run(outcome, memory, job.id);
  }
  async stop(): Promise<void> {
    this.closing = true;
    for (const task of this.running.values()) task.controller.abort('shutdown');
    await Promise.all([...this.running.values()].map(task => task.work));
  }
}
