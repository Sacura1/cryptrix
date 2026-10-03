import { DAILY_GAMES, HOSTED_GAMES, HOSTED_REQUESTS, readyAgents } from './admission.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { z } from 'zod';
import { capacity, digest, equipmentCommitment, readEquipmentIntent, FILL_MS, formatUsdc, GAME_IDS, MAX_STAKE, MIN_STAKE, parseUsdc, payoutUnits, requireThat, ROUND_MS, rules, stakeFor, type Agent, type Entry, type GameId, type Match } from './domain.js';
import { actionSchema, botAction, defaultEquipment, equipmentSchema, initialise, observation, publicState, resolveRound, validateAction } from './engine.js';
import { Auth, newToken } from './auth.js';
import type { ChainGateway, ChainSnapshot } from './chain.js';
import { Store } from './store.js';
import { replayData } from './replay.js';
import { acceptMining, advanceMining, initialiseMining, MINING_MS, miningBot, miningCommandSchema, miningFrame, miningObservation, miningRanks, miningRules, publicMining } from './mining.js';

const limitsSchema = z.object({
  maxStake: z.string().default('1'), dailyStake: z.string().default('10'),
  gamesPerDay: z.number().int().min(1).max(100).default(DAILY_GAMES),
  allowedGames: z.array(z.enum(GAME_IDS)).min(1).max(2).default([...GAME_IDS]),
  expiresAt: z.number().int().positive().optional(),
}).strict();
const agentSchema = z.object({
  name: z.string().trim().min(1).max(40), kind: z.enum(['hosted', 'external']),
  wallet: z.string().optional(), strategy: z.enum(['aggressive', 'defensive', 'explorer']).default('explorer'),
  limits: limitsSchema.prefault({}),
  instructions: z.string().trim().max(2000).default(''),
  walletProof: z.object({ challengeId: z.string().uuid(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).strict().optional(),
}).strict();
const createSchema = z.object({ game: z.enum(GAME_IDS), stake: z.string().optional(), equipment: equipmentSchema.default(defaultEquipment) }).strict();
const joinSchema = z.object({ expectedStake: z.string(), equipment: equipmentSchema.default(defaultEquipment) }).strict();

export class Platform {
  readonly auth: Auth;
  // Cache only immutable public JSON. Never share mutable/private match objects.
  private readonly snapshots = new Map<string, string>();
  private readonly snapshotExpiry = new Map<string, number>();
  snapshotJSON(id: string): string {
    const cached = this.snapshots.get(id);
    if (cached !== undefined && (this.snapshotExpiry.get(id) ?? Infinity) > this.now()) return cached;
    const match = this.store.match(id);
    const data = JSON.stringify(this.summary(match));
    // Legacy/paid summaries have time-dependent funding and refund flags.
    if (match.engineVersion === 2) {
      this.snapshots.set(id, data);
      this.snapshotExpiry.set(id, match.mode === 'paid' ? this.now() + 1000 : Infinity);
      if (this.snapshots.size > 128) { const oldest = this.snapshots.keys().next().value!; this.snapshots.delete(oldest); this.snapshotExpiry.delete(oldest); }
    }
    return data;
  }
  constructor(readonly store: Store, readonly mode: 'practice' | 'paid' = 'practice', readonly now: () => number = Date.now, readonly chain?: ChainGateway, origin = 'http://localhost:3000', readonly hostedMode: 'strategy' | 'model' | 'disabled' = 'strategy', readonly signingEnabled = false, readonly minimumRoundMs = 0, readonly miningEnabled = false) {
    requireThat(Number.isInteger(minimumRoundMs) && minimumRoundMs >= 0 && minimumRoundMs <= ROUND_MS, 'INVALID_CADENCE', 'Minimum round duration must fit within the decision deadline.', 500);
    requireThat(mode !== 'paid' || chain, 'ESCROW_REQUIRED', 'Paid mode requires a verified Arc escrow.', 503);
    this.auth = new Auth(store, origin, now, chain);
    store.onChange(id => { if (id === undefined) { this.snapshots.clear(); this.snapshotExpiry.clear(); } else { this.snapshots.delete(id); this.snapshotExpiry.delete(id); } });
  }
  async createAgent(owner: string, body: unknown) {
    const input = agentSchema.parse(body);
    const wallet = getAddress(input.wallet || owner).toLowerCase();
    if (input.kind === 'hosted' && this.mode === 'paid') await this.chain!.verifyHostedAccount(wallet, owner);
    else if (wallet !== owner) {
      requireThat(input.walletProof, 'WALLET_PROOF_REQUIRED', 'Sign a link-wallet challenge with the agent wallet.', 400);
      const proved = await this.auth.consume(input.walletProof.challengeId, input.walletProof.signature as Hex, 'link-wallet', owner);
      requireThat(proved === wallet, 'WRONG_WALLET_PROOF', 'Proof is for a different wallet.', 403);
    }
    const limits = this.limits(input.limits, input.kind);
    const token = newToken();
    const recovered = this.mode === 'paid' ? this.store.agents().find(a => a.wallet === wallet && a.chainOnly) : undefined;
    const agent: Agent = { id: recovered?.id ?? randomUUID(), owner, wallet, name: input.name, kind: input.kind, strategy: input.strategy, instructions: input.instructions, limits, automatic: false, tokenHash: digest(token), createdAt: recovered?.createdAt ?? this.now() };
    this.store.transaction(() => {
      if (input.kind === 'hosted') requireThat(!this.store.agents(owner).some(a => a.kind === 'hosted'), 'HOSTED_TIER_LIMIT', 'The starter tier supports one hosted agent.');
      if (this.mode === 'paid') requireThat(!this.store.agents().some(a => a.wallet === wallet && a.id !== recovered?.id), 'WALLET_ALREADY_LINKED', 'This entrant wallet already belongs to an agent.');
      this.store.saveAgent(agent);
    });
    return { agent: this.agentView(agent), runtimeToken: token, runtime: input.kind === 'hosted' ? `Hosted decisions: ${this.hostedMode}. Paid entry signing requires a separate restricted signer.` : 'Use this token only for this agent’s game API. Keep your wallet signing in your own runtime.' };
  }
  private limits(input: z.infer<typeof limitsSchema>, kind: Agent['kind']) {
    const maxStake = parseUsdc(input.maxStake), dailyStake = parseUsdc(input.dailyStake);
    requireThat(maxStake >= MIN_STAKE && maxStake <= MAX_STAKE && dailyStake >= MIN_STAKE && dailyStake <= 1_000_000_000, 'INVALID_LIMITS', 'Per-match limit must be 0.1–10 USDC and daily budget 0.1–1000 USDC.', 400);
    requireThat(input.gamesPerDay <= (kind === 'hosted' ? HOSTED_GAMES : DAILY_GAMES), 'DAILY_GAME_LIMIT', `Choose at most ${kind === 'hosted' ? HOSTED_GAMES : DAILY_GAMES} games per day.`, 400);
    const expiresAt = input.expiresAt ?? this.now() + 7 * 86_400_000;
    requireThat(expiresAt > this.now() && expiresAt <= this.now() + 30 * 86_400_000, 'INVALID_EXPIRY', 'Permissions must expire within thirty days.', 400);
    return { maxStake, dailyStake, gamesPerDay: input.gamesPerDay, allowedGames: [...new Set(input.allowedGames)], expiresAt };
  }
  owned(owner: string, id: string): Agent { const a = this.store.agent(id); requireThat(a.owner === owner, 'NOT_OWNER', 'This agent belongs to another owner.', 403); return a; }
  updateBehavior(owner: string, id: string, body: unknown) {
    const agent = this.owned(owner, id);
    const input = z.object({ strategy: z.enum(['aggressive', 'defensive', 'explorer']), instructions: z.string().trim().max(2000) }).strict().parse(body);
    Object.assign(agent, input); this.store.saveAgent(agent);
    return { agent: this.agentView(agent), notice: 'Changes apply to future decisions. Locked actions cannot be replaced.' };
  }
  updateLimits(owner: string, id: string, body: unknown) {
    const agent = this.owned(owner, id); agent.limits = this.limits(limitsSchema.parse(body), agent.kind); this.store.saveAgent(agent);
    return { agent: this.agentView(agent), notice: 'These are platform limits. Changes do not update on-chain wallet permissions; owners must authorise those separately.' };
  }
  automatic(owner: string, id: string, enabled: boolean) {
    const agent = this.owned(owner, id);
    requireThat(!enabled || this.mode === 'practice' || agent.kind === 'external' || (this.signingEnabled && this.hostedMode === 'model'), 'HOSTED_SIGNER_NOT_CONNECTED', 'Paid hosted automation needs a restricted signer and model decision worker.', 503);
    agent.automatic = enabled; this.store.saveAgent(agent);
    return { agent: this.agentView(agent), notice: enabled ? 'Automatic entry is enabled within limits.' : 'Future automatic entries stop. Active matches continue.' };
  }
  rotateToken(owner: string, id: string) {
    const agent = this.owned(owner, id), token = newToken(); agent.tokenHash = digest(token); this.store.saveAgent(agent);
    return { runtimeToken: token };
  }
  agentView(agent: Agent) {
    const { tokenHash: _, limits, ...safe } = agent;
    const usage = this.store.usage(agent.id, this.mode, this.now());
    const modelUsage = this.store.db.prepare('SELECT allowance,input_tokens,output_tokens FROM model_usage WHERE agent_id=? AND day=? AND mode=?').get(agent.id, Math.floor(this.now() / 86_400_000), this.mode);
    return { ...safe, hostedDecisions: agent.kind === 'hosted' ? this.hostedMode : undefined, modelUsage: modelUsage ?? { allowance: 0, input_tokens: 0, output_tokens: 0 }, limits: { ...limits, maxStake: formatUsdc(limits.maxStake), dailyStake: formatUsdc(limits.dailyStake) }, usage: { ...usage, grossStake: formatUsdc(usage.stake), nextReset: (Math.floor(this.now() / 86_400_000) + 1) * 86_400_000 }, walletPermissions: this.mode === 'practice' ? 'Not connected; no funds used.' : 'Enforced independently by the wallet; API limits are additional.' };
  }
  private eligible(agent: Agent, game: GameId, stake: number, currentMatch?: string) {
    const now = this.now();
    requireThat(agent.limits.expiresAt > now, 'PERMISSION_EXPIRED', 'Agent entry permission expired.');
    requireThat(agent.limits.allowedGames.includes(game) && stake <= agent.limits.maxStake, 'ENTRY_LIMIT', 'Game or stake is outside this agent’s limits.');
    const outstanding = this.store.outstanding();
    const active = outstanding.some(m => m.id !== currentMatch && (m.entries.some(e => e.agentId === agent.id) || m.chainParticipants?.includes(agent.wallet)));
    const intents = this.store.db.prepare('SELECT match_id FROM intents WHERE agent_id=? AND expires_at>? AND match_id<>?').all(agent.id, now, currentMatch ?? '');
    requireThat(!active && intents.length === 0, 'AGENT_BUSY', 'An agent may have only one pending or active match.');
    const used = this.store.usage(agent.id, this.mode, now);
    requireThat(used.games < Math.min(agent.limits.gamesPerDay, DAILY_GAMES) && used.stake + stake <= agent.limits.dailyStake, 'DAILY_LIMIT', 'Daily games or gross stake budget exhausted.');
    if (agent.kind === 'hosted') requireThat(used.games < HOSTED_GAMES && used.requests + 20 <= HOSTED_REQUESTS, 'HOSTED_TIER_LIMIT', 'Not enough hosted request allowance for a full match.');
  }
  create(agentId: string, key: string, body: unknown) {
    const input = createSchema.parse(body);
    return this.store.idempotent(agentId, key, { route: 'create', input }, () => {
      const agent = this.store.agent(agentId), stake = stakeFor(input.game, input.stake);
      requireThat(!this.miningEnabled || input.game !== 'flux-duel', 'COMING_SOON', 'Flux Duel is coming soon. Enter Cache Rush instead.');
      this.eligible(agent, input.game, stake);
      const seed = randomBytes(32).toString('hex');
      const commitment = digest(seed);
      const match: Match = { id: `0x${randomBytes(32).toString('hex')}`, game: input.game, mode: this.mode, status: this.mode === 'practice' ? 'open' : 'funding', creatorId: agentId, stake, fillDeadline: Math.floor((this.now() + FILL_MS) / 1000) * 1000, createdAt: this.now(), seed, commitment, rulesHash: digest({ rules: rules(input.game), commitment }), entries: [], pending: {}, history: [] };
      this.store.saveMatch(match);
      if (this.miningEnabled && input.game === 'cache-rush') { match.engineVersion = 2; match.miningMapVersion = 3; match.rulesHash = digest({ rules: miningRules, commitment }); }
      const equipmentSalt = this.mode === 'paid' ? `0x${randomBytes(32).toString('hex')}` : undefined;
      if (this.mode === 'practice') this.addEntry(match, agent, input.equipment);
      else this.intent(match, agent, input.equipment, equipmentSalt);
      this.store.saveMatch(match);
      return { match: this.summary(match), transactions: this.mode === 'paid' ? this.chain!.prepare(match, agent, true, input.equipment, equipmentSalt) : [], fundingRequired: this.mode === 'paid' };
    });
  }
  join(agentId: string, matchId: string, key: string, body: unknown) {
    const input = joinSchema.parse(body);
    return this.store.idempotent(agentId, key, { route: 'join', matchId, input }, () => {
      const agent = this.store.agent(agentId), match = this.store.match(matchId);
      requireThat(match.mode === this.mode && match.status === 'open' && match.fillDeadline > this.now(), 'MATCH_NOT_OPEN', 'This match is no longer accepting entries.');
      requireThat((match.chainParticipants?.length ?? match.entries.length) < capacity(match.game) && match.chainStatus !== 2, 'MATCH_FULL', 'The escrow has already filled this match.');
      requireThat(parseUsdc(input.expectedStake) === match.stake, 'STAKE_CHANGED', 'Accept the exact advertised entry stake.', 400);
      requireThat(!match.entries.some(e => e.agentId === agent.id || e.wallet === agent.wallet), 'ALREADY_JOINED', 'Agent or wallet is already in this match.');
      requireThat(!match.entries.some(e => this.store.agent(e.agentId).owner === agent.owner), 'SAME_OWNER', 'An owner may enter only one agent in a match.');
      this.eligible(agent, match.game, match.stake, match.id);
      const equipmentSalt = this.mode === 'paid' ? `0x${randomBytes(32).toString('hex')}` : undefined;
      if (this.mode === 'practice') this.addEntry(match, agent, input.equipment);
      else this.intent(match, agent, input.equipment, equipmentSalt);
      this.store.saveMatch(match);
      return { match: this.summary(match), transactions: this.mode === 'paid' ? this.chain!.prepare(match, agent, false, input.equipment, equipmentSalt) : [], fundingRequired: this.mode === 'paid' };
    });
  }
  private intent(match: Match, agent: Agent, equipment: Entry['equipment'], equipmentSalt?: string) {
    requireThat(!this.store.db.prepare('SELECT 1 FROM intents WHERE match_id=? AND agent_id=?').get(match.id, agent.id), 'ENTRY_INTENT_LOCKED', 'An entry intent already exists; retry with its original idempotency key.');
    this.store.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run(match.id, agent.id, match.fillDeadline, JSON.stringify({ equipment, equipmentSalt }));
  }
  private addEntry(match: Match, agent: Agent, equipment: Entry['equipment']) {
    requireThat(match.entries.length < capacity(match.game), 'MATCH_FULL', 'The match is full.');
    match.entries.push({ agentId: agent.id, wallet: agent.wallet, equipment });
    this.store.use(agent.id, this.mode, this.now(), match.stake);
    if (match.entries.length === capacity(match.game)) this.start(match);
  }
  private start(match: Match) {
    if (match.engineVersion === 2) {
      match.status = 'active'; match.mining = { startedAt: this.now(), world: initialiseMining(match.entries, match.seed, match.miningMapVersion ?? 1), inputs: [], frames: [] };
      match.roundDeadline = this.now() + MINING_MS; return;
    }
    match.status = 'active'; match.state = initialise(match.game, match.entries, match.seed); match.roundDeadline = this.now() + ROUND_MS;
  }
  async confirm(agentId: string, matchId: string, hash: Hex) {
    const before = this.store.match(matchId), agent = this.store.agent(agentId);
    requireThat(before.mode === 'paid' && this.chain, 'NOT_PAID', 'Practice matches need no funding receipt.', 400);
    const snapshot = await this.chain.confirm(before, agent.wallet, hash);
    this.store.transaction(() => {
      const match = this.store.match(matchId);
      this.reconcile(match, snapshot);
      this.store.saveMatch(match);
    });
    return { match: this.summary(this.store.match(matchId)) };
  }
  private reconcile(match: Match, snapshot: ChainSnapshot) {
    requireThat(snapshot.status !== 0 || match.entries.length === 0, 'CHAIN_STATE_MISSING', 'A funded match disappeared from the configured escrow.', 503);
    // Concurrent RPC requests may finish out of order. Entrants and escrow status never regress.
    if (snapshot.participants.length < (match.chainParticipants?.length ?? match.entries.length) || (match.chainStatus !== undefined && snapshot.status < match.chainStatus)) return;
    // Preserve on-chain participant order even if confirmation requests arrive out of order.
    const entries: Entry[] = [];
    const blocked: string[] = [];
    for (const wallet of snapshot.participants) {
      const existing = match.entries.find(e => e.wallet === wallet);
      const indexed = this.store.db.prepare("SELECT json_extract(doc,'$.timestamp') AS timestamp FROM chain_events WHERE json_extract(doc,'$.name')='MatchJoined' AND json_extract(doc,'$.args.id')=? AND lower(json_extract(doc,'$.args.entrant'))=? LIMIT 1").get(match.id, wallet);
      const enteredAt = snapshot.enteredAt?.[wallet] ?? (indexed?.timestamp ? Number(indexed.timestamp) : undefined);
      if (existing && snapshot.equipment?.[wallet]) requireThat(snapshot.equipment[wallet] === equipmentCommitment(existing.equipment, existing.equipmentSalt), 'EQUIPMENT_MISMATCH', 'Funded equipment commitment does not match the admitted equipment.');
      if (existing) { this.store.bookEntry(match.id, wallet, existing.agentId, match.stake, enteredAt ?? this.now(), enteredAt !== undefined, true); entries.push(existing); continue; }
      let agent = this.store.agents().find(a => a.wallet === wallet);
      if (!agent) {
        agent = { id: randomUUID(), owner: wallet, wallet, name: `Unlinked ${wallet.slice(-6)}`, kind: 'external', strategy: 'explorer', automatic: false, chainOnly: true, tokenHash: digest(newToken()), createdAt: this.now(), limits: { maxStake: 0, dailyStake: 0, gamesPerDay: 0, allowedGames: [], expiresAt: 0 } };
        this.store.saveAgent(agent);
      }
      const intent = this.store.db.prepare('SELECT equipment FROM intents WHERE match_id=? AND agent_id=?').get(match.id, agent.id) as { equipment: string } | undefined;
      this.store.bookEntry(match.id, wallet, agent.id, match.stake, enteredAt ?? this.now(), enteredAt !== undefined);
      const gear = intent ? readEquipmentIntent(intent.equipment) : snapshot.equipment?.[wallet] === digest(defaultEquipment) ? { equipment: defaultEquipment } : undefined;
      if (!gear) { blocked.push(wallet); continue; }
      if (snapshot.equipment?.[wallet]) requireThat(snapshot.equipment[wallet] === equipmentCommitment(gear.equipment, gear.equipmentSalt), 'EQUIPMENT_MISMATCH', 'Equipment does not match the on-chain commitment.');
      entries.push({ agentId: agent.id, wallet, ...gear });
      this.store.db.prepare('DELETE FROM intents WHERE match_id=? AND agent_id=?').run(match.id, agent.id);
    }
    match.entries = entries; match.chainParticipants = snapshot.participants; match.blockedEntries = blocked; match.chainStatus = snapshot.status; match.chainResolveDeadline = snapshot.resolveDeadline;
    if (snapshot.status === 0 && match.status === 'funding' && match.fillDeadline <= this.now()) { match.status = 'cancelled'; }
    if (snapshot.status === 4) { match.status = 'cancelled'; match.settlement = 'refund-claimable'; }
    else if (snapshot.status === 3) {
      requireThat(match.status === 'finished', 'UNEXPECTED_SETTLEMENT', 'Escrow settled without a local game result.', 409);
      requireThat(!snapshot.resultHash || (snapshot.resultHash === match.resultHash && digest(snapshot.ranks) === digest(match.ranks)), 'SETTLEMENT_MISMATCH', 'On-chain result differs from the verified local replay; do not report it as settled.', 409);
      match.settlement = 'settled';
    } else if (snapshot.status === 2 && blocked.length) match.status = 'funding';
    else if (snapshot.status === 2 && (match.status === 'funding' || match.status === 'open')) this.start(match);
    else if (snapshot.status === 1 && match.status === 'funding') match.status = 'open';
  }
  async sync(matchId: string) {
    const before = this.store.match(matchId);
    requireThat(before.mode === 'paid' && this.chain, 'NOT_PAID', 'Only paid matches synchronise with Arc.', 400);
    const snapshot = await this.chain.snapshot(before);
    this.store.transaction(() => { const match = this.store.match(matchId); this.reconcile(match, snapshot); this.store.saveMatch(match); });
    return { match: this.summary(this.store.match(matchId)), expired: snapshot.resolveDeadline > 0 && snapshot.resolveDeadline <= this.now() };
  }
  async revealEquipment(agentId: string, matchId: string, body: unknown) {
    const gear = z.union([z.object({ equipment: equipmentSchema, equipmentSalt: z.string().regex(/^0x[0-9a-f]{64}$/).optional() }).strict(), equipmentSchema.transform(equipment => ({ equipment, equipmentSalt: undefined }))]).parse(body);
    const { equipment, equipmentSalt } = gear, agent = this.store.agent(agentId), match = this.store.match(matchId);
    requireThat(this.chain && match.mode === 'paid' && !match.state && !match.mining, 'EQUIPMENT_LOCKED', 'Equipment is locked once game execution starts.');
    const snapshot = await this.chain.snapshot(match);
    requireThat(snapshot.participants.includes(agent.wallet) && snapshot.equipment?.[agent.wallet] === equipmentCommitment(equipment, equipmentSalt), 'EQUIPMENT_MISMATCH', 'Reveal must match this funded wallet’s on-chain equipment commitment.', 403);
    this.store.transaction(() => {
      const current = this.store.match(match.id);
      requireThat(!current.state && !current.mining, 'EQUIPMENT_LOCKED', 'Game execution already started.');
      const existing = this.store.db.prepare('SELECT equipment FROM intents WHERE match_id=? AND agent_id=?').get(match.id, agent.id);
      const previous = existing ? readEquipmentIntent(String(existing.equipment)) : undefined;
      requireThat(!previous || equipmentCommitment(previous.equipment, previous.equipmentSalt) === equipmentCommitment(equipment, equipmentSalt), 'ENTRY_INTENT_LOCKED', 'Entry equipment cannot be replaced.');
      if (!existing) this.store.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run(match.id, agent.id, match.fillDeadline, JSON.stringify(gear));
      this.reconcile(current, snapshot); this.store.saveMatch(current);
    });
    return this.summary(this.store.match(match.id));
  }
  submit(agentId: string, matchId: string, key: string, body: unknown) {
    if (this.store.match(matchId).engineVersion === 2) {
      const input = z.object({ round: z.number().int().min(1).max(20), action: miningCommandSchema }).strict().parse(body);
      return this.command(agentId, matchId, key, { sequence: input.round, command: input.action });
    }
    const input = z.object({ round: z.number().int().min(1).max(20), action: actionSchema }).strict().parse(body);
    return this.store.idempotent(agentId, key, { route: 'action', matchId, input }, () => {
      const match = this.store.match(matchId);
      requireThat(match.status === 'active' && match.state, 'MATCH_NOT_ACTIVE', 'Match is not active.');
      requireThat(match.entries.some(e => e.agentId === agentId), 'NOT_PARTICIPANT', 'This agent is not in the match.', 403);
      requireThat(match.roundDeadline! > this.now(), 'ROUND_EXPIRED', 'Round deadline passed.');
      requireThat(input.round === match.state.round + 1, 'STALE_ROUND', 'Action is for a different round.');
      requireThat(!match.pending[agentId], 'ACTION_LOCKED', 'This round’s action is already locked.');
      validateAction(match.state, agentId, input.action);
      match.pending[agentId] = input.action;
      if (match.entries.every(e => match.pending[e.agentId]) && this.roundReady(match)) this.advance(match);
      this.store.saveMatch(match);
      return { acceptedRound: input.round, locked: true, match: this.summary(match) };
    });
  }
  private roundReady(match: Match) { return this.now() >= match.roundDeadline! - ROUND_MS + this.minimumRoundMs; }
  command(agentId: string, matchId: string, key: string, body: unknown) {
    const input = z.object({ sequence: z.number().int().min(1).max(20), command: miningCommandSchema }).strict().parse(body);
    return this.store.idempotent(agentId, key, { route: 'mining-command', matchId, input }, () => {
      const match = this.store.match(matchId);
      requireThat(match.status === 'active' && match.mining && this.now() < match.mining.startedAt + MINING_MS, 'MATCH_NOT_ACTIVE', 'Mining match is not active.');
      this.advanceMine(match);
      match.mining.inputs.push(acceptMining(match.mining.world, agentId, input.sequence, input.command));
      this.store.saveMatch(match);
      return { acceptedSequence: input.sequence, locked: true, match: this.summary(match) };
    });
  }
  private advanceMine(match: Match) {
    const mining = match.mining!;
    advanceMining(mining.world, Math.max(mining.world.elapsedMs, this.now() - mining.startedAt), f => mining.frames.push(miningFrame(f)));
    if (mining.world.elapsedMs === MINING_MS) {
      match.status = 'finished'; delete match.roundDeadline;
      match.ranks = miningRanks(mining.world); match.payouts = payoutUnits('cache-rush', match.stake, match.ranks);
      match.resultHash = digest(this.replayData(match));
      if (match.mode === 'paid') match.settlement = 'pending';
    }
  }
  private advance(match: Match) {
    const actions = Object.fromEntries(match.entries.map(e => [e.agentId, match.pending[e.agentId] ?? { type: 'wait' as const }]));
    const resolved = resolveRound(match.state!, actions);
    match.state = resolved.state; match.history.push({ round: resolved.state.round, actions, events: resolved.events, state: resolved.state });
    match.pending = {}; match.roundDeadline = this.now() + ROUND_MS;
    if (resolved.ranks) {
      match.status = 'finished'; delete match.roundDeadline; match.ranks = resolved.ranks;
      match.payouts = payoutUnits(match.game, match.stake, resolved.ranks);
      match.resultHash = digest(this.replayData(match));
      if (match.mode === 'paid') match.settlement = 'pending';
    }
  }
  tick(clockHolder?: string): void {
    let ownsClock = !clockHolder;
    this.store.transaction(() => {
      if (clockHolder) {
        const lease = this.store.db.prepare("SELECT holder,expires_at FROM leases WHERE name='match-clock'").get();
        if (lease?.holder !== clockHolder || Number(lease.expires_at) <= this.now()) return;
        ownsClock = true;
      }
      for (const match of this.store.outstanding()) {
        if ((match.status === 'funding' || match.status === 'open') && match.fillDeadline <= this.now() && match.mode === 'practice') { match.status = 'cancelled'; this.store.saveMatch(match); continue; }
        if (match.status !== 'active') continue;
        if (match.mining) {
          this.advanceMine(match);
          if (match.status === 'active' && match.mode === 'practice' && this.hostedMode === 'strategy') {
            for (const p of match.mining.world.players) {
              if (!p.alive || p.job || p.sequence >= 20 || p.nextDecisionAt > match.mining.world.elapsedMs) continue;
              const agent = this.store.agent(p.id);
              if (agent.kind !== 'hosted') continue;
              match.mining.inputs.push(acceptMining(match.mining.world, p.id, p.sequence + 1, miningBot(match.mining.world, p.id, agent.strategy)));
              this.store.use(p.id, match.mode, this.now(), 0, 0, 1);
            }
          }
          this.store.saveMatch(match); continue;
        }
        if (!match.state) continue;
        if (match.roundDeadline! <= this.now()) this.advance(match);
        else if (match.entries.every(e => match.pending[e.agentId]) && this.roundReady(match)) this.advance(match);
        else if (match.mode === 'practice' && this.hostedMode === 'strategy') {
          for (const entry of match.entries) {
            const agent = this.store.agent(entry.agentId);
            if (agent.kind === 'hosted' && !match.pending[agent.id]) {
              match.pending[agent.id] = botAction(match.state, agent.id, agent.strategy);
              this.store.use(agent.id, match.mode, this.now(), 0, 0, 1);
            }
          }
          if (match.entries.every(e => match.pending[e.agentId]) && this.roundReady(match)) this.advance(match);
        }
        this.store.saveMatch(match);
      }
    });
    if (!ownsClock) return;
    // Entry changes each have their own transaction; one quota failure never stops the scheduler.
    if (this.mode === 'practice' && this.hostedMode !== 'disabled') for (const agent of readyAgents(this.store.agents().filter(a => a.kind === 'hosted' && a.automatic), id => this.store.usage(id, this.mode, this.now()))) {
      try {
        const game = this.miningEnabled ? 'cache-rush' : agent.limits.allowedGames[0]!;
        const offer = this.store.outstanding().filter(m => m.status === 'open').sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).find(m => m.game === game && m.fillDeadline > this.now() && m.entries.every(e => this.store.agent(e.agentId).owner !== agent.owner) && m.stake <= agent.limits.maxStake);
        const key = `automatic:${randomUUID()}`;
        if (offer) this.join(agent.id, offer.id, key, { expectedStake: formatUsdc(offer.stake) });
        else this.create(agent.id, key, { game, stake: formatUsdc(game === 'cache-rush' ? 1_000_000 : Math.min(1_000_000, agent.limits.maxStake)) });
      } catch { /* Limits, offline permissions and existing matches block new entries only. */ }
    }
    // Retain expired intents: an earlier on-chain entry may still need receipt reconciliation.
  }
  summary(match: Match) {
    const liveEvents = match.history.at(-1)?.events ?? [];
    const funded = match.chainParticipants?.length ?? match.entries.length;
    return { id: match.id, game: match.game, mode: match.mode, status: match.status, stake: formatUsdc(match.stake), pot: formatUsdc(match.stake * funded), capacity: capacity(match.game), filled: funded, awaitingEquipment: match.blockedEntries ?? [], fillDeadline: match.fillDeadline, createdAt: match.createdAt, roundDeadline: match.roundDeadline, escrowResolveDeadline: match.chainResolveDeadline, refundAvailable: match.mode === 'paid' && ((match.chainStatus === 1 && match.fillDeadline <= this.now()) || (match.chainStatus === 2 && !!match.chainResolveDeadline && match.chainResolveDeadline <= this.now())), seedCommitment: match.commitment, rulesHash: match.rulesHash,
      engineVersion: match.engineVersion,
      participants: match.entries.map(e => ({ agentId: e.agentId, name: this.store.agent(e.agentId).name, wallet: e.wallet })), state: match.mining ? publicMining(match.mining.world) : match.state ? publicState(match.state) : null,
      events: match.mining ? match.mining.world.events.map(e => e.text) : match.game === 'cache-rush' && match.status !== 'finished' ? liveEvents.filter(e => e.includes(' deposited ')) : liveEvents,
      resolvedActions: match.game === 'flux-duel' ? match.history.at(-1)?.actions : undefined,
      minimumRoundMs: this.minimumRoundMs,
      earliestResolveAt: match.status === 'active' ? match.roundDeadline! - ROUND_MS + this.minimumRoundMs : null,
      payouts: match.payouts?.map((amount, i) => ({ agentId: match.entries[i]!.agentId, wallet: match.entries[i]!.wallet, rankGroup: match.ranks![i], amount: formatUsdc(amount) })), resultHash: match.resultHash, settlement: match.settlement,
      notice: match.mode === 'practice' ? 'Practice: amounts are simulated. No USDC is staked or paid.' : 'Paid: entry requires confirmed escrow funding. Settlement depends on the disclosed resolver.' };
  }
  observe(agentId: string, matchId: string) {
    const match = this.store.match(matchId);
    requireThat(match.entries.some(e => e.agentId === agentId), 'NOT_PARTICIPANT', 'This agent is not in the match.', 403);
    if (match.mining) {
      const w = match.mining.world, p = w.players.find(p => p.id === agentId)!;
      return { matchId, version: 2, mapGeneration: match.miningMapVersion ?? 1, status: match.status, nextRound: p.sequence + 1, nextSequence: p.sequence + 1,
        roundDeadline: match.mining.startedAt + MINING_MS, actionLocked: !!p.job || !p.alive || p.sequence >= 20 || p.nextDecisionAt > w.elapsedMs,
        observation: miningObservation(w, agentId) };
    }
    return { matchId, status: match.status, nextRound: match.state ? match.state.round + 1 : null, roundDeadline: match.roundDeadline, actionLocked: !!match.pending[agentId], observation: match.state ? observation(match.state, agentId) : null };
  }
  private replayData(match: Match) { return replayData(match); }
  replay(matchId: string) {
    const match = this.store.match(matchId);
    requireThat(match.status === 'finished', 'REPLAY_NOT_READY', 'Full replay becomes public only when the match finishes.');
    return { ...this.replayData(match), resultHash: match.resultHash };
  }
}
