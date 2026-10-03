import { canonical, capacity, digest, equipmentCommitment, formatUsdc, GAME_IDS, payoutUnits, requireThat, rules, stakeFor, type Match } from './domain.js';
import { actionSchema, equipmentSchema, initialise, resolveRound, validateAction } from './engine.js';
import { acceptMining, advanceMining, initialiseMining, MINING_MS, miningFrame, miningRanks, rulesForMining, publicMining, type MiningFrame } from './mining.js';

export function replayData(match: Match) {
  if (match.engineVersion === 2 && match.mining) return { version: 2, matchId: match.id, rules: rulesForMining(match.miningMapVersion ?? 1), seed: match.seed, seedCommitment: match.commitment,
    rulesHash: match.rulesHash, entries: match.entries, initialState: publicMining(initialiseMining(match.entries, match.seed, match.miningMapVersion ?? 1)),
    inputs: match.mining.inputs, frames: match.mining.frames, ranks: match.ranks, payouts: match.payouts };
  return { version: 1, matchId: match.id, rules: rules(match.game), seed: match.seed, seedCommitment: match.commitment, rulesHash: match.rulesHash, entries: match.entries, rounds: match.history, ranks: match.ranks, payouts: match.payouts };
}
export function verifyResult(match: Match): void {
  const check = (value: unknown) => requireThat(value, 'REPLAY_INVALID', 'Replay verification failed; settlement is blocked.', 409);
  check(GAME_IDS.includes(match.game));
  stakeFor(match.game, formatUsdc(match.stake));
  check(match.status === 'finished' && match.entries.length === capacity(match.game));
  check(new Set(match.entries.map(e => e.wallet.toLowerCase())).size === match.entries.length);
  check(new Set(match.entries.map(e => e.agentId)).size === match.entries.length);
  check(digest(match.seed) === match.commitment && digest({ rules: match.engineVersion === 2 ? rulesForMining(match.miningMapVersion ?? 1) : rules(match.game), commitment: match.commitment }) === match.rulesHash);
  for (const entry of match.entries) { equipmentSchema.parse(entry.equipment); equipmentCommitment(entry.equipment, entry.equipmentSalt); }
  if (match.engineVersion === 2) {
    check(match.game === 'cache-rush' && match.mining && match.history.length === 0 && !match.state);
    const state = initialiseMining(match.entries, match.seed, match.miningMapVersion ?? 1), frames: MiningFrame[] = [];
    for (const input of match.mining!.inputs) {
      check(Number.isSafeInteger(input.at) && input.at % 500 === 0 && input.at >= state.elapsedMs && input.at < MINING_MS);
      advanceMining(state, input.at, f => frames.push(miningFrame(f)));
      acceptMining(state, input.agentId, input.sequence, input.command);
    }
    advanceMining(state, MINING_MS, f => frames.push(miningFrame(f)));
    check(canonical(state) === canonical(match.mining!.world) && canonical(frames) === canonical(match.mining!.frames));
    const ranks = miningRanks(state);
    check(canonical(ranks) === canonical(match.ranks) && canonical(payoutUnits('cache-rush', match.stake, ranks)) === canonical(match.payouts));
    check(digest(replayData(match)) === match.resultHash); return;
  }
  check(match.history.length > 0 && match.history.length <= 20);
  let state = initialise(match.game, match.entries, match.seed);
  let finalRanks: number[] | undefined;
  for (const [index, record] of match.history.entries()) {
    check(!finalRanks && record.round === index + 1);
    check(Object.keys(record.actions).length === match.entries.length && match.entries.every(e => record.actions[e.agentId]));
    for (const entry of match.entries) validateAction(state, entry.agentId, actionSchema.parse(record.actions[entry.agentId]));
    const resolved = resolveRound(state, record.actions);
    check(canonical(resolved.state) === canonical(record.state) && canonical(resolved.events) === canonical(record.events));
    state = resolved.state; finalRanks = resolved.ranks;
  }
  check(finalRanks && canonical(finalRanks) === canonical(match.ranks) && canonical(state) === canonical(match.state));
  check(canonical(payoutUnits(match.game, match.stake, finalRanks!)) === canonical(match.payouts));
  check(digest(replayData(match)) === match.resultHash);
}
