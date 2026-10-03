import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_ROUNDS, requireThat, type Action, type DuelState, type Entry, type GameState, type Match, type Position, type RushState } from './domain.js';

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), direction: z.enum(['north', 'south', 'east', 'west']) }).strict(),
  ...(['attack', 'shield', 'scan', 'recharge', 'wait', 'collect', 'deposit'] as const).map(type => z.object({ type: z.literal(type) }).strict()),
]);
export const equipmentSchema = z.object({ attack: z.number().int().min(0).max(2), armor: z.number().int().min(0).max(2), sensor: z.number().int().min(0).max(2) }).strict().refine(e => e.attack * 2 + e.armor * 2 + e.sensor <= 6, 'Equipment costs exceed the budget of six.');
export const defaultEquipment = { attack: 1, armor: 1, sensor: 2 };
const vectors = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
const key = (p: Position) => `${p.x},${p.y}`;
const distance = (a: Position, b: Position) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
function move(p: Position, action: Action, size: number): Position {
  if (action.type !== 'move') return { x: p.x, y: p.y };
  const [dx, dy] = vectors[action.direction];
  return { x: Math.max(0, Math.min(size - 1, p.x + dx)), y: Math.max(0, Math.min(size - 1, p.y + dy)) };
}
function random(seed: string): () => number {
  let counter = 0;
  return () => createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32BE(0) / 2 ** 32;
}
export function initialise(game: Match['game'], entries: Entry[], seed: string): GameState {
  if (game === 'flux-duel') return { game, round: 0, players: entries.map((entry, i) => ({ id: entry.agentId, x: i ? 5 : 1, y: 3, health: 12, energy: 6, objective: 0, equipment: entry.equipment, aim: 0, intel: false })) };
  const bases = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const starts = [{ x: 1, y: 0 }, { x: 9, y: 0 }, { x: 10, y: 1 }, { x: 10, y: 9 }, { x: 9, y: 10 }, { x: 1, y: 10 }, { x: 0, y: 9 }, { x: 0, y: 1 }];
  const hazards = [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }];
  const rng = random(seed);
  const cells = Array.from({ length: 121 }, (_, i) => ({ x: i % 11, y: Math.floor(i / 11) })).filter(p => ![...bases, ...starts, ...hazards].some(q => key(p) === key(q)));
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cells[i], cells[j]] = [cells[j]!, cells[i]!]; }
  const relics = Object.fromEntries(cells.slice(0, 24).map(p => [key(p), 1 + Math.floor(rng() * 3)]));
  const state: RushState = { game, round: 0, relics, bases, hazards, players: entries.map((entry, i) => ({ id: entry.agentId, ...starts[i]!, cargo: 0, deposited: 0, seen: {}, slowed: false })) };
  refreshVision(state, {});
  return state;
}
function refreshVision(state: RushState, actions: Record<string, Action>): void {
  for (const p of state.players) {
    const radius = actions[p.id]?.type === 'scan' ? 4 : 2;
    for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) {
      if (distance(p, { x, y }) <= radius) p.seen[`${x},${y}`] = { value: state.relics[`${x},${y}`] ?? 0, round: state.round };
    }
  }
}
export function validateAction(state: GameState, agentId: string, action: Action): void {
  const p = state.players.find(p => p.id === agentId);
  requireThat(p, 'NOT_PARTICIPANT', 'This agent is not in the match.', 403);
  const allowed = state.game === 'flux-duel' ? ['move', 'attack', 'shield', 'scan', 'recharge', 'wait'] : ['move', 'scan', 'collect', 'deposit', 'wait'];
  requireThat(allowed.includes(action.type), 'INVALID_ACTION', 'This action is unavailable in this game.', 400);
  if (state.game === 'flux-duel') {
    const player = state.players.find(p => p.id === agentId)!;
    const cost = { move: 1, attack: 3, shield: 2, scan: 1, recharge: 0, wait: 0 }[action.type as 'move' | 'attack' | 'shield' | 'scan' | 'recharge' | 'wait'];
    requireThat(player.energy >= cost, 'LOW_ENERGY', 'Not enough energy for this action.', 400);
  }
}
export function resolveRound(previous: GameState, actions: Record<string, Action>): { state: GameState; events: string[]; ranks?: number[] } {
  const state = structuredClone(previous);
  state.round++;
  const events: string[] = [];
  if (state.game === 'flux-duel') {
    const intents = state.players.map(p => move(p, actions[p.id] ?? { type: 'wait' }, 7));
    // Simultaneous collisions block both; swapping cells is allowed.
    if (key(intents[0]!) === key(intents[1]!)) intents.forEach((_, i) => { intents[i] = { x: state.players[i]!.x, y: state.players[i]!.y }; });
    state.players.forEach((p, i) => { Object.assign(p, intents[i]); });
    const damage = [0, 0];
    state.players.forEach((p, i) => {
      const action = actions[p.id] ?? { type: 'wait' };
      const enemy = state.players[1 - i]!;
      if (action.type === 'move') p.energy--;
      if (action.type === 'shield') p.energy -= 2;
      if (action.type === 'scan') { p.energy--; p.aim = 1; p.intel = true; }
      if (action.type === 'recharge') p.energy = Math.min(6, p.energy + 3);
      if (action.type === 'wait') p.energy = Math.min(6, p.energy + 1);
      if (action.type === 'attack') {
        p.energy -= 3;
        if (distance(p, enemy) <= 2 + p.equipment.sensor) {
          let hit = Math.max(1, 3 + p.equipment.attack + p.aim - enemy.equipment.armor);
          if (actions[enemy.id]?.type === 'shield') hit = Math.ceil(hit / 2);
          damage[1 - i] = hit;
          events.push(`${p.id} hit ${enemy.id} for ${hit}.`);
        } else events.push(`${p.id} missed: target out of range.`);
        p.aim = 0;
      }
      if (p.x === 3 && p.y === 3) p.objective++;
    });
    state.players.forEach((p, i) => { p.health = Math.max(0, p.health - damage[i]!); });
    if (state.round >= MAX_ROUNDS || state.players.some(p => p.health === 0)) {
      const scores = state.players.map(p => [p.health > 0 ? 1 : 0, p.objective, p.health, p.energy]);
      return { state, events, ranks: denseRanks(scores) };
    }
  } else {
    for (const p of state.players) {
      const action = actions[p.id] ?? { type: 'wait' };
      if (action.type === 'move') {
        if (p.slowed) { p.slowed = false; events.push(`${p.id} rested under heavy cargo.`); }
        else {
          Object.assign(p, move(p, action, 11));
          p.slowed = p.cargo >= 3;
          if (state.hazards.some(h => key(h) === key(p)) && p.cargo > 0) { p.cargo--; events.push(`${p.id} lost one cargo to a hazard.`); }
        }
      } else p.slowed = false;
      if (action.type === 'deposit' && state.bases.some(b => key(b) === key(p))) {
        events.push(`${p.id} deposited ${p.cargo}.`); p.deposited += p.cargo; p.cargo = 0;
      }
    }
    // Shared tiles are allowed. Contested collection rotates priority by round.
    for (let step = 0; step < state.players.length; step++) {
      const p = state.players[(state.round - 1 + step) % state.players.length]!;
      if (actions[p.id]?.type !== 'collect') continue;
      const available = state.relics[key(p)] ?? 0;
      const taken = Math.min(5 - p.cargo, available);
      if (taken) { p.cargo += taken; state.relics[key(p)] = available - taken; events.push(`${p.id} collected ${taken}.`); }
    }
    refreshVision(state, actions);
    if (state.round >= MAX_ROUNDS) return { state, events, ranks: denseRanks(state.players.map(p => [p.deposited])) };
  }
  return { state, events };
}
function denseRanks(scores: number[][]): number[] {
  const compare = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!; return 0; };
  const unique = scores.filter((s, i) => scores.findIndex(t => compare(s, t) === 0) === i).sort(compare);
  return scores.map(s => unique.findIndex(t => compare(s, t) === 0));
}
export function publicState(state: GameState): unknown {
  if (state.game === 'flux-duel') return { game: state.game, round: state.round, players: state.players.map(({ id, x, y, health, energy, objective }) => ({ id, x, y, health, energy, objective })) };
  return { game: state.game, round: state.round, bases: state.bases, hazards: state.hazards, players: state.players.map(({ id, x, y, deposited }) => ({ id, x, y, deposited })) };
}
export function observation(state: GameState, agentId: string): unknown {
  const p = state.players.find(p => p.id === agentId);
  requireThat(p, 'NOT_PARTICIPANT', 'This agent is not in the match.', 403);
  if (state.game === 'flux-duel') {
    const own = state.players.find(p => p.id === agentId)!;
    const enemy = state.players.find(p => p.id !== agentId)!;
    return { ...publicState(state) as object, self: own, opponentEquipment: own.intel ? enemy.equipment : null, legalActions: ['move', 'attack', 'shield', 'scan', 'recharge', 'wait'] };
  }
  return { ...publicState(state) as object, self: p, legalActions: ['move', 'scan', 'collect', 'deposit', 'wait'] };
}

export function botAction(state: GameState, agentId: string, strategy: 'aggressive' | 'defensive' | 'explorer'): Action {
  if (state.game === 'flux-duel') {
    return tacticalDuelAction(state, agentId, strategy);
  }
  const own = state.players.find(p => p.id === agentId)!;
  const base = [...state.bases].sort((a, b) => distance(own, a) - distance(own, b))[0]!;
  const roundsLeft = MAX_ROUNDS - state.round;
  if (own.cargo && (own.cargo >= (strategy === 'defensive' ? 2 : 3) || roundsLeft <= distance(own, base) * 2 + 2)) return distance(own, base) === 0 ? { type: 'deposit' } : towards(own, base);
  if ((own.seen[key(own)]?.value ?? 0) > 0 && own.cargo < 5) return { type: 'collect' };
  const targets = Object.entries(own.seen).filter(([, cell]) => cell.value > 0).map(([pos]) => { const [x, y] = pos.split(',').map(Number); return { x: x!, y: y! }; }).sort((a, b) => distance(own, a) - distance(own, b));
  if (targets[0]) return towards(own, targets[0]);
  if (state.round % 4 === 0) return { type: 'scan' };
  const unexplored = Array.from({ length: 121 }, (_, i) => ({ x: i % 11, y: Math.floor(i / 11) })).filter(p => !own.seen[key(p)]).sort((a, b) => distance(own, a) - distance(own, b));
  return unexplored[0] ? towards(own, unexplored[0]) : own.cargo ? towards(own, base) : { type: 'wait' };
}

function duelChoices(state: DuelState, id: string): Action[] {
  const own = state.players.find(p => p.id === id)!;
  const choices: Action[] = [];
  for (const direction of Object.keys(vectors) as (keyof typeof vectors)[]) {
    const action: Action = { type: 'move', direction };
    if (own.energy >= 1 && key(move(own, action, 7)) !== key(own)) choices.push(action);
  }
  const enemy = state.players.find(p => p.id !== id)!;
  if (own.energy >= 3 && distance(own, enemy) <= 2 + own.equipment.sensor) choices.push({ type: 'attack' });
  if (own.energy >= 2) choices.push({ type: 'shield' });
  if (own.energy >= 1 && !own.aim) choices.push({ type: 'scan' });
  if (own.energy < 6) choices.push({ type: 'recharge' });
  choices.push({ type: 'wait' });
  return choices;
}

// A small risk-sensitive planner, using public state and the bot's own scan intel.
// It never reads the other bot's strategy, pending action, aim or unscanned gear.
function tacticalDuelAction(state: DuelState, id: string, strategy: 'aggressive' | 'defensive' | 'explorer'): Action {
  const own = state.players.find(p => p.id === id)!, rival = state.players.find(p => p.id !== id)!;
  const model = structuredClone(state), enemy = model.players.find(p => p.id !== id)!;
  enemy.equipment = own.intel ? { ...rival.equipment } : { ...defaultEquipment };
  enemy.aim = 0; enemy.intel = false;
  const center = {x: 3, y: 3}, ownIndex = state.players.findIndex(p => p.id === id);
  // Distinct opening plans: rush the scoring zone or take a flank. Neither policy
  // knows the rival's plan. The sensor scan then makes later range decisions informed.
  if (state.round < 2 && own.energy >= 1) return strategy === 'aggressive'
    ? towards(own, center) : {type: 'move', direction: ownIndex ? 'north' : 'south'};
  if (strategy !== 'aggressive' && !own.intel && own.energy >= 4) return {type: 'scan'};
  const finishingHit = Math.max(1, 3 + own.equipment.attack + own.aim - enemy.equipment.armor);
  if (strategy === 'defensive' && own.energy >= 5 && rival.energy < 3 && distance(own, rival) <= 2 + own.equipment.sensor)
    return {type: 'attack'};
  if (strategy === 'defensive' && own.energy >= 3 && own.energy <= 4 && rival.energy < 3 && rival.health > finishingHit)
    return {type: 'recharge'};
  if (strategy === 'aggressive' && own.energy >= 1 && distance(own, rival) > 2 + own.equipment.sensor)
    return towards(own, own.objective >= 2 ? rival : center);
  // Withdraw under pressure and bank energy for the next escape/counter window.
  // A retreat only evades damage if it actually leaves range; there is no dodge roll.
  if (strategy !== 'aggressive' && own.health <= 9 && own.energy >= 1 && rival.energy >= 3 && distance(own, rival) <= 2 + enemy.equipment.sensor) {
    const escapes = duelChoices(model, id).filter((action): action is Extract<Action, {type: 'move'}> => action.type === 'move')
      .filter(action => distance(move(own, action, 7), rival) > distance(own, rival))
      .sort((a, b) => distance(move(own, b, 7), rival) - distance(move(own, a, 7), rival) || distance(move(own, a, 7), center) - distance(move(own, b, 7), center));
    if (escapes[0]) return escapes[0];
  }
  const possibilities = duelChoices(model, enemy.id).map(action => {
    let weight = 0.35;
    if (action.type === 'attack') weight = distance(own, enemy) <= 2 + enemy.equipment.sensor ? 12 : 0.1;
    if (action.type === 'recharge') weight = enemy.energy < 3 ? 5 : 1;
    if (action.type === 'move') weight = distance(move(enemy, action, 7), center) < distance(enemy, center) ? 2 : 0.6;
    if (action.type === 'shield') weight = enemy.health <= 4 && own.energy >= 3 ? 1.8 : 0.2;
    return {action, weight};
  });
  const value = (next: DuelState, ranks?: number[]) => {
    const self = next.players[ownIndex]!, foe = next.players[1 - ownIndex]!;
    if (ranks) return ranks[ownIndex] === ranks[1 - ownIndex] ? 0 : ranks[ownIndex] === 0 ? 1000 : -1000;
    const safety = strategy === 'defensive' ? 3.2 : strategy === 'explorer' ? 2.6 : 1.8;
    const offense = strategy === 'aggressive' ? 3.1 : 2.6;
    const gap = distance(self, foe), enemyReach = 2 + foe.equipment.sensor;
    const zone = strategy === 'aggressive' ? 1.7 : 1.6;
    let score = (self.health - own.health) * safety + (rival.health - foe.health) * offense;
    score += (self.energy - own.energy) * (own.energy < 3 ? 0.7 : 0.25);
    score += (self.objective - own.objective) * zone - (foe.objective - rival.objective) * 1.1;
    score -= distance(self, center) * (state.round > 13 ? 1.6 : strategy === 'aggressive' ? 1.2 : 0.8);
    // Range advantage supports meaningful retreat and pursuit, not cosmetic moves.
    if (self.energy >= 3 && gap <= 2 + self.equipment.sensor) score += 1.4;
    if (foe.energy >= 3 && gap <= enemyReach) score -= strategy === 'aggressive' ? 0.5 : 2;
    if (gap > enemyReach && gap <= 2 + self.equipment.sensor) score += 2;
    if (gap > 2 + self.equipment.sensor) score -= (gap - 2 - self.equipment.sensor) * (strategy === 'aggressive' ? 2.3 : 1.1);
    if (self.aim > own.aim) score += 1.2;
    if (self.intel && !own.intel) score += strategy === 'aggressive' ? 0.8 : 3;
    // Forecast the next turn's pressure: a depleted core in firing range is costly.
    if (self.energy < 3 && foe.energy >= 3 && gap <= enemyReach) score -= 1.8;
    return score;
  };
  let best: Action = {type: 'wait'}, bestScore = -Infinity;
  for (const action of duelChoices(model, id)) {
    let sum = 0, total = 0, worst = Infinity;
    for (const option of possibilities) {
      const resolved = resolveRound(model, {[id]: action, [enemy.id]: option.action});
      const score = value(resolved.state as DuelState, resolved.ranks);
      sum += score * option.weight; total += option.weight; worst = Math.min(worst, score);
    }
    const risk = strategy === 'defensive' ? 0.4 : strategy === 'explorer' ? 0.3 : 0.2;
    let score = sum / total * (1 - risk) + worst * risk;
    // Stable role-based flank preference breaks identical-policy collision loops.
    if (action.type === 'move') {
      const flank = ownIndex ? 'south' : 'north';
      if (action.direction === flank) score += 0.04;
      if (key(move(own, action, 7)) === key(rival)) score -= 0.5;
    }
    if (score > bestScore) { bestScore = score; best = action; }
  }
  return best;
}
function towards(own: Position, target: Position): Action {
  if (own.x !== target.x) return { type: 'move', direction: own.x < target.x ? 'east' : 'west' };
  if (own.y !== target.y) return { type: 'move', direction: own.y < target.y ? 'south' : 'north' };
  return { type: 'wait' };
}
