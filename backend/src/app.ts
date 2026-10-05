import { isIP } from 'node:net';
import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import type { Hex } from 'viem';
import { Fault, STAKES, MAX_OPEN_ROOMS, GAME_IDS, readEquipmentIntent, rules } from './domain.js';
import { USDC, type ChainGateway } from './chain.js';
import { Platform } from './platform.js';
import { Store } from './store.js';
import type { SigningService } from './payments/signer.js';
import { timingSafeEqual } from 'node:crypto';
import { digest } from './domain.js';
import { verifyResult } from './replay.js';
import { miningRules } from './mining.js';
import { miningCommandSchema } from './mining.js';
import { agentGuide, openapi } from './discovery.js';

export interface AppOptions { database?: string; databaseUrl?: string; stateNamespace?: string; mode?: 'practice' | 'paid'; now?: () => number; chain?: ChainGateway; origin?: string; logger?: boolean; signing?: SigningService; opsToken?: string; allowedOrigins?: string[]; minimumRoundMs?: number; miningEnabled?: boolean; readiness?: () => { ready: boolean; checks: Record<string, boolean> }; trustedProxyHops?: number; proxyToken?: string }
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{2,4096}$/);
const matchId = (req: FastifyRequest) => z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(req.params).id;
const agentId = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
function bearer(req: FastifyRequest) {
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) throw new Fault(401, 'UNAUTHORISED', 'Supply the appropriate bearer token.');
  return value.slice(7);
}
function key(req: FastifyRequest) { return z.string().parse(req.headers['idempotency-key']); }

export async function buildApp(options: AppOptions = {}) {
  const store = await Store.open(options.database, options.databaseUrl, options.stateNamespace);
  const platform = new Platform(store, options.mode, options.now, options.chain, options.origin, options.minimumRoundMs, options.miningEnabled);
  const app = Fastify({ trustProxy: options.trustedProxyHops ? (_address: string, hop: number) => hop < options.trustedProxyHops! : false, logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-cryptrix-proxy', 'body.signature', 'runtimeToken', 'token'] } : false, bodyLimit: 16_384, requestTimeout: 30_000 });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', keyGenerator: req => {
    // Independent authenticated agents may share one host/IP. Invalid tokens never bypass IP limits.
    if (req.headers.authorization?.startsWith('Bearer ')) {
      try { return `agent:${platform.auth.agent(req.headers.authorization.slice(7)).wallet}`; } catch { /* fall back to IP */ }
    }
    const proof = req.headers['x-cryptrix-proxy'], ip = req.headers['x-cryptrix-client-ip'];
    if (options.proxyToken && typeof proof === 'string' && typeof ip === 'string' && isIP(ip)
      && timingSafeEqual(Buffer.from(digest(proof)), Buffer.from(digest(options.proxyToken)))) return `proxy:${ip}`;
    return req.ip;
  } });
  const runtime = (req: FastifyRequest) => platform.auth.agent(bearer(req));

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof Fault) return reply.code(error.status).send({ error: error.code, message: error.message, details: error.details });
    if (error instanceof ZodError) return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'Request fields are invalid.', issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many requests. Wait a moment before retrying.' });
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: 'INVALID_REQUEST', message: 'Request could not be accepted.' });
    req.log.error('Request failed; inspect sanitized operations status for recovery.');
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Request failed. No successful entry should be assumed.' });
  });
  app.addHook('onRequest', (_req, reply, done) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); done(); });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.headers.origin) return;
    const allowed = options.allowedOrigins ?? [options.origin ?? 'http://localhost:3000'];
    if (!allowed.includes(req.headers.origin)) throw new Fault(403, 'ORIGIN_DENIED', 'Browser origin is not configured.');
    reply.header('Access-Control-Allow-Origin', req.headers.origin).header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS').header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  });
  app.options('/*', (_req, reply) => reply.code(204).send());

  app.get('/health', () => ({ ok: true, mode: platform.mode, chainId: platform.chain?.chainId ?? null, paidExecution: platform.mode === 'paid' ? 'Agents fund escrow directly; a bounded service signer settles results and returns winnings and refunds.' : 'disabled' }));
  app.get('/ready', (_req, reply) => {
    const result = options.readiness?.() ?? { ready: true, checks: { database: true } };
    return reply.code(result.ready ? 200 : 503).send({ ...result, mode: platform.mode });
  });
  app.get('/config', () => ({ mode: platform.mode, chainId: platform.chain?.chainId ?? null, escrow: platform.chain?.escrow ?? null, usdc: platform.chain ? USDC : null, usdcDecimals: 6, stakes: STAKES, maxOpenRooms: MAX_OPEN_ROOMS, roomSize: 8, fillWindowMs: 900000, fundingWindowMs: 120000, publicSpectating: true, resultVerification: 'Server replay checked before trusted resolver signs', randomness: 'Server CSPRNG committed with offer; operator remains trusted' }));
  const ops = (req: FastifyRequest) => {
    if (!options.opsToken || !timingSafeEqual(Buffer.from(digest(bearer(req))), Buffer.from(digest(options.opsToken)))) throw new Fault(401, 'OPS_UNAUTHORISED', 'Supply the operations credential.');
  };
  app.get('/ops/status', req => {
    ops(req);
    return { services: store.db.prepare('SELECT * FROM service_status').all(), jobs: store.db.prepare('SELECT kind,status,count(*) AS count FROM jobs GROUP BY kind,status').all(), cursors: store.db.prepare('SELECT * FROM chain_cursors').all(), databaseVersion: Number(store.db.prepare('PRAGMA user_version').get()?.user_version), clock: store.db.prepare("SELECT expires_at,fence FROM leases WHERE name='match-clock'").get() ?? null };
  });
  app.get('/ops/jobs', req => { ops(req); return { jobs: store.db.prepare('SELECT key,kind,status,hash,attempts,next_at,error,created_at,updated_at FROM jobs ORDER BY updated_at DESC LIMIT 100').all() }; });
  app.get('/ops/audit', req => { ops(req); return { events: store.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT 100').all() }; });
  app.post('/ops/jobs/retry', req => {
    ops(req); const body = z.object({ key: z.string().min(1).max(256) }).strict().parse(req.body);
    const row = store.db.prepare('SELECT status,payload FROM jobs WHERE key=?').get(body.key);
    if (!row || !['retry', 'paused', 'needs-review'].includes(String(row.status))) throw new Fault(409, 'JOB_NOT_RETRYABLE', 'Only pending or reviewed jobs can be retried.');
    const payload = JSON.parse(String(row.payload));
    if (payload.deadline && payload.deadline <= platform.now()) throw new Fault(409, 'OPERATION_EXPIRED', 'Expired signatures need nonce reconciliation; they cannot be blindly retried.');
    store.db.prepare("UPDATE jobs SET status='retry',next_at=0,error=NULL WHERE key=?").run(body.key);
    store.audit('operator-retry', body.key, {}, platform.now()); return { queued: true };
  });
  app.get('/agent.md', (_req, reply) => reply.type('text/markdown; charset=utf-8').send(agentGuide));
  app.get('/openapi.json', () => openapi);
  app.get('/games', () => ({ games: options.miningEnabled ? [{ ...miningRules, actionSchema: z.toJSONSchema(miningCommandSchema) }, { ...rules('flux-duel'), availability: 'coming-soon' }] : GAME_IDS.map(game => rules(game)) }));
  app.post('/auth/challenge', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, req => {
    const body = z.object({ wallet: address }).strict().parse(req.body); return platform.auth.challenge(body.wallet);
  });
  app.post('/auth/verify', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async req => {
    const body = z.object({ challengeId: z.string().uuid(), signature }).strict().parse(req.body); return platform.auth.signIn(body.challengeId, body.signature as Hex);
  });
  app.post('/auth/logout', req => { runtime(req); platform.auth.logout(bearer(req)); return { signedOut: true }; });
  app.get('/agents', () => ({ agents: store.agents().map(a => platform.agentView(a)) }));
  app.get('/agents/:id', req => ({ agent: platform.agentView(store.agent(agentId(req))) }));
  app.patch('/runtime/me', req => {
    const agent = runtime(req), body = z.object({ name: z.string().trim().min(1).max(40) }).strict().parse(req.body);
    agent.name = body.name; store.saveAgent(agent); return { agent: platform.agentView(agent) };
  });

  app.get('/matches', req => {
    const query = z.object({ status: z.enum(['open', 'active', 'finished', 'cancelled']).default('open'), game: z.enum(GAME_IDS).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict().parse(req.query);
    // SQL filters before pagination so filtered matches are not skipped.
    const rows = query.game ? store.db.prepare('SELECT doc FROM matches WHERE status=? AND game=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(query.status, query.game, query.limit, query.offset).map(row => JSON.parse(String(row.doc))) : store.matches(query.status, query.limit, query.offset);
    return { matches: rows.filter(m => query.status !== 'open' || m.fillDeadline > platform.now()).map(m => platform.summary(m)), limit: query.limit, offset: query.offset };
  });
  app.get('/matches/:id', (req, reply) => reply.type('application/json').send(platform.snapshotJSON(matchId(req))));
  app.get('/matches/:id/replay', req => platform.replay(matchId(req)));
  app.get('/matches/:id/verification', req => { const match = store.match(matchId(req)); verifyResult(match); return { verified: true, resultHash: match.resultHash, scope: 'Replay, ranks, payouts and commitments are internally consistent. This does not prove unbiased generation or honest private action handling.' }; });
  app.get('/chain/matches', req => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict().parse(req.query);
    return { matches: store.db.prepare('SELECT doc FROM chain_matches ORDER BY rowid DESC LIMIT ? OFFSET ?').all(query.limit, query.offset).map(row => JSON.parse(String(row.doc))) };
  });
  app.get('/chain/matches/:id', req => { const row = store.db.prepare('SELECT doc FROM chain_matches WHERE id=?').get(matchId(req)); if (!row) throw new Fault(404, 'CHAIN_MATCH_NOT_FOUND', 'Match has not been indexed.'); return JSON.parse(String(row.doc)); });
  app.get('/agents/:id/activity', req => {
    const agent = store.agent(agentId(req));
    const events = store.db.prepare("SELECT doc FROM chain_events WHERE lower(json_extract(doc,'$.args.account'))=? OR lower(json_extract(doc,'$.args.entrant'))=? OR lower(json_extract(doc,'$.args.creator'))=? ORDER BY rowid DESC LIMIT 100").all(agent.wallet, agent.wallet, agent.wallet).map(row => JSON.parse(String(row.doc)));
    return { events, notice: 'Claims are aggregate account credits; they are not allocated to individual matches.' };
  });
  app.get('/agents/:id/matches', req => {
    const agent = store.agent(agentId(req));
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict().parse(req.query);
    const rows = store.db.prepare(`SELECT m.doc FROM matches m WHERE json_extract(m.doc,'$.creatorId')=? OR EXISTS (SELECT 1 FROM json_each(m.doc,'$.entries') e WHERE json_extract(e.value,'$.agentId')=?) OR EXISTS (SELECT 1 FROM intents i WHERE i.match_id=m.id AND i.agent_id=?) ORDER BY m.created_at DESC,m.id LIMIT ? OFFSET ?`).all(agent.id, agent.id, agent.id, query.limit, query.offset);
    return { matches: rows.map(row => platform.summary(JSON.parse(String(row.doc)))), limit: query.limit, offset: query.offset };
  });
  app.get('/matches/:id/settlement', req => {
    const match = store.match(matchId(req)); if (match.mode !== 'paid' || !platform.chain) throw new Fault(409, 'NOT_PAID', 'Practice results have no settlement transaction.');
    return { transaction: platform.chain.settlement(match) };
  });
  app.post('/matches/:id/sync', req => { runtime(req); return platform.sync(matchId(req)); });
  let streams = 0;
  const closeStreams = new Set<() => void>();
  app.get('/matches/:id/stream', (req, reply) => {
    const id = matchId(req);
    const initial = platform.snapshotJSON(id);
    if (streams >= 100) throw new Fault(503, 'STREAM_LIMIT', 'Live stream capacity reached; use the public snapshot endpoint.');
    reply.hijack(); reply.raw.writeHead(200, { ...(req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' } : {}), 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); streams++;
    let closed = false, last = '';
    const send = () => { if (closed || reply.raw.writableLength > 65_536) return; const data = platform.snapshotJSON(id); if (data !== last) { reply.raw.write(`event: match\ndata: ${data}\n\n`); last = data; } else reply.raw.write(': heartbeat\n\n'); };
    const timer = setInterval(send, JSON.parse(initial).engineVersion === 2 ? 250 : 1000);
    const close = () => { if (closed) return; closed = true; clearInterval(timer); closeStreams.delete(close); streams--; reply.raw.end(); };
    closeStreams.add(close); reply.raw.on('close', close); send();
  });

  app.get('/runtime/me', req => platform.agentView(runtime(req)));
  app.get('/runtime/wallet', async req => {
    const agent = runtime(req);
    if (!platform.chain) throw new Fault(409, 'NOT_PAID', 'Practice has no onchain credits.');
    return { wallet: agent.wallet, claimableUsdc: await platform.chain.credits(agent.wallet), transaction: platform.chain.claimAccount(agent.wallet) };
  });
  app.get('/runtime/matches/:id/refund', req => {
    const agent = runtime(req), match = store.match(matchId(req));
    if (!platform.chain || !match.chainParticipants?.includes(agent.wallet)) throw new Fault(403, 'NOT_PARTICIPANT', 'Only funded entrants can request their refund plan.');
    if (!platform.summary(match).refundAvailable) throw new Fault(409, 'REFUND_NOT_READY', 'The match is not past its refund deadline.');
    return { transaction: platform.chain.refund(match.id) };
  });
  app.get('/runtime/matches', req => {
    const agent = runtime(req);
    const pending = new Set(store.db.prepare('SELECT match_id FROM intents WHERE agent_id=?').all(agent.id).map(row => String(row.match_id)));
    return { matches: store.outstanding().filter(m => m.entries.some(e => e.agentId === agent.id) || m.creatorId === agent.id || pending.has(m.id)).map(m => platform.summary(m)) };
  });
  app.get('/runtime/matches/:id/entry-intent', req => {
    const agent = runtime(req), match = store.match(matchId(req));
    const intent = store.db.prepare('SELECT equipment FROM intents WHERE match_id=? AND agent_id=?').get(match.id, agent.id);
    if (!intent || match.mode !== 'paid' || !platform.chain) throw new Fault(404, 'NO_PENDING_INTENT', 'No pending paid entry intent for this agent.');
    if ((match.creatorId === agent.id && match.status === 'funding' ? (match.fundingDeadline ?? match.fillDeadline) : match.fillDeadline) <= platform.now()) throw new Fault(409, 'INTENT_EXPIRED', 'Entry window expired. Reconcile any previously submitted transaction; do not resubmit.');
    const gear = readEquipmentIntent(String(intent.equipment));
    return { match: platform.summary(match), fundingRequired: true, transactions: platform.chain.prepare(match, agent, match.creatorId === agent.id, gear.equipment, gear.equipmentSalt) };
  });
  app.post('/runtime/matches', (req, reply) => reply.code(201).send(platform.create(runtime(req).id, key(req), req.body)));
  app.post('/runtime/matches/:id/join', req => platform.join(runtime(req).id, matchId(req), key(req), req.body));
  app.post('/runtime/matches/:id/confirm', req => { const body = z.object({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict().parse(req.body); return platform.confirm(runtime(req).id, matchId(req), body.transactionHash as Hex); });
  app.post('/runtime/matches/:id/equipment', req => platform.revealEquipment(runtime(req).id, matchId(req), req.body));
  app.get('/runtime/matches/:id/observation', req => platform.observe(runtime(req).id, matchId(req)));
  app.post('/runtime/matches/:id/actions', req => platform.submit(runtime(req).id, matchId(req), key(req), req.body));
  app.post('/runtime/matches/:id/commands', req => platform.command(runtime(req).id, matchId(req), key(req), req.body));

  app.addHook('preClose', async () => { for (const close of closeStreams) close(); });
  app.addHook('onSend', async (_req, reply) => { if (!reply.raw.headersSent) await store.flush(); });
  app.addHook('onClose', async () => { await store.shutdown(); });
  return { app, platform, store };
}
