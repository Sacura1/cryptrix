import { randomBytes, randomUUID } from 'node:crypto';
import { getAddress, type Hex } from 'viem';
import { z } from 'zod';
import { capacity, Fault, MAX_OPEN_ROOMS, digest, equipmentCommitment, readEquipmentIntent, FILL_MS, formatUsdc, GAME_IDS, MAX_STAKE, MIN_STAKE, parseUsdc, payoutUnits, requireThat, ROUND_MS, rules, stakeFor, type Agent, type Entry, type GameId, type Match } from './domain.js';
import { actionSchema, defaultEquipment, equipmentSchema, initialise, observation, publicState, resolveRound, validateAction } from './engine.js';
import { Auth, newToken } from './auth.js';
import type { ChainGateway, ChainSnapshot } from './chain.js';
import { Store } from './store.js';
import { replayData } from './replay.js';
import { acceptMining, advanceMining, initialiseMining, MINING_MS, miningCommandSchema, miningFrame, miningObservation, miningRanks, miningRules, publicMining } from './mining.js';

const createSchema = z.object({ game: z.enum(GAME_IDS), stake: z.string().optional(), title: z.string().trim().max(40).regex(/^[^\p{Cc}\p{Cf}]*$/u, 'Use a single-line title without control characters.').optional(), equipment: equipmentSchema.default(defaultEquipment) }).strict();
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
  constructor(readonly store: Store, readonly mode: 'practice' | 'paid' = 'practice', readonly now: () => number = Date.now, readonly chain?: ChainGateway, origin = 'http://localhost:3000', readonly minimumRoundMs = 0, readonly miningEnabled = false) {
    requireThat(Number.isInteger(minimumRoundMs) && minimumRoundMs >= 0 && minimumRoundMs <= ROUND_MS, 'INVALID_CADENCE', 'Minimum round duration must fit within the decision deadline.', 500);
    requireThat(mode !== 'paid' || chain, 'ESCROW_REQUIRED', 'Paid mode requires a verified Arc escrow.', 503);
    this.auth = new Auth(store, origin, now, chain);
    store.onChange(id => { if (id === undefined) { this.snapshots.clear(); this.snapshotExpiry.clear(); } else { this.snapshots.delete(id); this.snapshotExpiry.delete(id); } });
  }
  agentView(agent: Agent) {
    return { id: agent.id, wallet: agent.wallet, name: agent.name, createdAt: agent.createdAt };
  }
  private eligible(agent: Agent, _game: GameId, _stake: number, currentMatch?: string) {
    const active = this.store.outstanding().some(m => m.id !== currentMatch && (m.entries.some(e => e.wallet === agent.wallet) || m.chainParticipants?.includes(agent.wallet)));
    const intents = this.store.db.prepare('SELECT match_id FROM intents WHERE agent_id=? AND expires_at>? AND match_id<>?').all(agent.id, this.now(), currentMatch ?? '');
    requireThat(!active && intents.length === 0, 'AGENT_BUSY', 'A wallet may have only one pending or active match.');
  }
  create(agentId: string, key: string, body: unknown) {
    const input = createSchema.parse(body);
    return this.store.idempotent(agentId, key, { route: 'create', input }, () => {
      const agent = this.store.agent(agentId), stake = stakeFor(input.game, input.stake);
      requireThat(!this.miningEnabled || input.game !== 'flux-duel', 'COMING_SOON', 'Flux Duel is coming soon. Enter Cache Rush instead.');
      this.eligible(agent, input.game, stake);
      const waiting = this.store.outstanding().filter(m => m.mode === this.mode && (m.status === 'open' || m.status === 'funding') && (m.status === 'funding' ? (m.fundingDeadline ?? m.fillDeadline) : m.fillDeadline) > this.now());
      const existing = waiting.find(m => m.game === input.game && m.stake === stake);
      if (existing) throw new Fault(409, existing.status === 'open' ? 'ROOM_ALREADY_OPEN' : 'ROOM_FUNDING', 'A room at this stake already exists. Join when funded, or wait.', { match: this.summary(existing) });
      if (waiting.length >= MAX_OPEN_ROOMS) throw new Fault(409, 'OPEN_ROOM_LIMIT', 'Five rooms are already waiting. Join an available room or wait.', { matches: waiting.filter(m => m.status === 'open').map(m => this.summary(m)) });
      const seed = randomBytes(32).toString('hex');
      const commitment = digest(seed);
      const match: Match = { protocolVersion: 2, id: `0x${randomBytes(32).toString('hex')}`, game: input.game, mode: this.mode, status: this.mode === 'practice' ? 'open' : 'funding', creatorId: agentId, stake, fundingDeadline: Math.floor((this.now() + 120_000) / 1000) * 1000, fillDeadline: Math.floor((this.now() + FILL_MS) / 1000) * 1000, createdAt: this.now(), seed, commitment, rulesHash: digest({ rules: rules(input.game), commitment }), entries: [], pending: {}, history: [] };
      match.title = input.title || undefined;
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
    this.store.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run(match.id, agent.id, match.creatorId === agent.id ? (match.fundingDeadline ?? match.fillDeadline) : match.fillDeadline, JSON.stringify({ equipment, equipmentSalt }));
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
        agent = { id: randomUUID(), wallet, name: `Agent ${wallet.slice(-6)}`, createdAt: this.now() };
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
    if (snapshot.status === 0 && match.status === 'funding' && (match.fundingDeadline ?? match.fillDeadline) <= this.now()) { match.status = 'cancelled'; }
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
          this.store.saveMatch(match); continue;
        }
        if (!match.state) continue;
        if (match.roundDeadline! <= this.now()) this.advance(match);
        else if (match.entries.every(e => match.pending[e.agentId]) && this.roundReady(match)) this.advance(match);
        this.store.saveMatch(match);
      }
    });
    if (!ownsClock) return;
    // Expired intents remain available for reconciliation of previously submitted transactions.
  }
  summary(match: Match) {
    const liveEvents = match.history.at(-1)?.events ?? [];
    const funded = match.chainParticipants?.length ?? match.entries.length;
    return { id: match.id, title: match.title || (match.game === 'cache-rush' ? 'Cache Rush' : 'Flux Duel'), game: match.game, mode: match.mode, status: match.status, stake: formatUsdc(match.stake), pot: formatUsdc(match.stake * funded), capacity: capacity(match.game), filled: funded, awaitingEquipment: match.blockedEntries ?? [], fundingDeadline: match.fundingDeadline, fillDeadline: match.fillDeadline, createdAt: match.createdAt, roundDeadline: match.roundDeadline, escrowResolveDeadline: match.chainResolveDeadline, refundAvailable: match.mode === 'paid' && ((match.chainStatus === 1 && match.fillDeadline <= this.now()) || (match.chainStatus === 2 && !!match.chainResolveDeadline && match.chainResolveDeadline <= this.now())), seedCommitment: match.commitment, rulesHash: match.rulesHash,
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
