import { z } from 'zod';
import { digest, requireThat, type Entry, type Position } from './domain.js';

export const MINING_MS = 240_000;
export const MINING_STEP = 500;
export const legacyMiningRules = {
  version: 2, game: 'cache-rush', capacity: 8, durationMs: MINING_MS, stepMs: MINING_STEP,
  stakeMin: '0.100000', stakeMax: '10.000000', entryStake: '1.000000', payoutsBps: [6000, 2500, 1500],
  board: 24, cargoCapacity: 24, venomMs: 30_000, crownValue: 35, decisionsPerAgent: 20,
  ties: 'Banked value determines dense ranks. Tied agents share prizes for occupied positions; remainder follows entry order.',
  execution: 'Independent timed jobs. Inspect, mine, bank, recover, retreat, repel, treat, clear or wait. No shared turn barrier.',
};
export const generationTwoMiningRules = { ...legacyMiningRules, mapGeneration: 2, mapDesign: 'Fresh seeded terrain regions, spawns, extraction stations, clinics, treasure, hazards and hidden Crown each expedition.' };
export const historicalMiningRules = { ...generationTwoMiningRules, mapGeneration: 3,
  deposits: 'Interior clue density 34%, outer clue density 18%; clues yield treasure 78% of the time. Unmarked sites yield hidden pockets 3.5% of the time. Spawn/station surroundings have no deposits. One hidden Crown remains worth 35.' };
export const miningRules = { ...historicalMiningRules, protocolVersion: 2, stakeMin: '1.000000', stakeMax: '5.000000', stakes: ['1', '2', '3', '4', '5'], entryStake: 'creator-selected' };
export const rulesForMining = (mapVersion = 1, protocolVersion = 1) => protocolVersion === 2 ? miningRules : mapVersion >= 3 ? historicalMiningRules : mapVersion === 2 ? generationTwoMiningRules : legacyMiningRules;
const target = z.object({ x: z.number().int().min(0).max(23), y: z.number().int().min(0).max(23) }).strict();
export const miningCommandSchema = z.object({ type: z.enum(['mine', 'inspect', 'bank', 'recover', 'retreat', 'repel', 'treat', 'clear', 'wait']), target: target.optional() }).strict();
export type MiningCommand = z.infer<typeof miningCommandSchema>;
export interface MiningTile { zone: number; blocked: boolean; vein: number; value: number; danger: 'snake' | 'venom' | 'cave' | null; crown: boolean }
export interface MiningJob { type: MiningCommand['type']; target: Position; path: Position[]; phase: 'walk' | 'inspect' | 'dig' | 'work'; until: number; started: number; from: Position; duration: number }
export interface Miner extends Position {
  id: string; health: number; cargo: number; deposited: number; crown: boolean; alive: boolean;
  antidotes: number; venomUntil: number | null; sequence: number; nextDecisionAt: number; job: MiningJob | null;
  known: Record<string, { value: number; danger: MiningTile['danger']; crown: boolean }>;
}
export interface MiningEvent extends Position { id: number; at: number; kind: string; agentId?: string; text: string; value?: number }
export interface MiningSnake extends Position { id: string; venomous: boolean; health: number; born: number; nextAt: number; phase: 'coil' | 'chase' | 'strike'; targetId?: string }
export interface Excavation { depth: number; depleted: boolean; crackUntil: number | null; rubble: boolean }
export interface MiningDrop extends Position { value: number; crown: boolean }
export interface MiningWorld {
  game: 'cache-rush'; version: 2; round: number; elapsedMs: number; durationMs: number; board: number; seed: string;
  tiles: MiningTile[]; players: Miner[]; bases: Position[]; clinics: Position[];
  excavations: Record<string, Excavation>; snakes: MiningSnake[]; drops: MiningDrop[]; events: MiningEvent[]; eventSequence: number;
}
export interface MiningPublic extends Omit<MiningWorld, 'seed' | 'tiles' | 'players'> {
  tiles: Pick<MiningTile, 'zone' | 'blocked' | 'vein'>[];
  players: Omit<Miner, 'known' | 'nextDecisionAt'>[];
}
export interface MiningInput { at: number; agentId: string; sequence: number; command: MiningCommand }
export type MiningFrame = Omit<MiningPublic, 'tiles'>;
export interface MiningRecording { startedAt: number; world: MiningWorld; inputs: MiningInput[]; frames: MiningFrame[] }
export function miningFrame(w: MiningPublic): MiningFrame { const { tiles: _, ...frame } = w; return frame; }
const key = (p: Position) => `${p.x},${p.y}`;
const distance = (a: Position, b: Position) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const random = (seed: string, salt: string) => parseInt(digest({ seed, salt }).slice(2, 10), 16) / 0x100000000;
const tileAt = (w: MiningWorld, p: Position) => w.tiles[p.y * 24 + p.x]!;
function emit(w: MiningWorld, kind: string, p: Position, text: string, agentId?: string, value?: number) {
  w.events.push({ id: ++w.eventSequence, at: w.elapsedMs, kind, x: p.x, y: p.y, text, agentId, value });
  w.events = w.events.filter(e => e.at >= w.elapsedMs - 10_000);
}
function initialiseLegacyMining(entries: Entry[], seed: string): MiningWorld {
  const starts = [[2, 2], [21, 21], [21, 2], [2, 21], [2, 11], [21, 12], [11, 2], [12, 21]];
  const bases = [{ x: 1, y: 1 }, { x: 22, y: 22 }, { x: 22, y: 1 }, { x: 1, y: 22 }, { x: 11, y: 1 }, { x: 12, y: 22 }];
  const clinics = [{ x: 5, y: 12 }, { x: 18, y: 11 }];
  const w: MiningWorld = { game: 'cache-rush', version: 2, round: 0, elapsedMs: 0, durationMs: MINING_MS, board: 24, seed,
    tiles: [], players: entries.map((e, i) => ({ id: e.agentId, x: starts[i]![0]!, y: starts[i]![1]!, health: 6, cargo: 0, deposited: 0, crown: false, alive: true, antidotes: 1, venomUntil: null, sequence: 0, nextDecisionAt: 1500 + i * 1100, job: null, known: {} })),
    bases, clinics, excavations: {}, snakes: [], drops: [], events: [], eventSequence: 0 };
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const p = { x, y }, central = distance(p, { x: 12, y: 12 }) < 7;
    const reserved = [...bases, ...clinics, ...w.players].some(b => distance(b, p) <= 1) || x === 11 || x === 12 || y === 11 || y === 12;
    const r = random(seed, `tile:${x}:${y}`), v = random(seed, `value:${x}:${y}`), h = random(seed, `hazard:${x}:${y}`);
    const blocked = !reserved && r < .12;
    const vein = !blocked && r > (central ? .32 : .47) ? (central && r > .82 ? 2 : 1) : 0;
    const west = x + Math.sin(y * .65) * 1.8 < 12, north = y + Math.sin(x * .7) * 2 < 12;
    w.tiles.push({ zone: west ? (north ? 0 : 1) : (north ? 2 : 3), blocked, vein,
      value: blocked ? 0 : vein ? 3 + Math.floor(v * (central ? 12 : 7)) : v > .75 ? 3 : 0,
      danger: !blocked && !reserved && h < .13 ? 'venom' : !blocked && !reserved && h < .27 ? 'snake' : !blocked && !reserved && h < .37 ? 'cave' : null,
      crown: x === 12 && y === 12 });
  }
  const crown = tileAt(w, { x: 12, y: 12 }); crown.vein = 2; crown.value = 35; crown.blocked = false;
  return w;
}
export function initialiseMining(entries: Entry[], seed: string, mapVersion = 3): MiningWorld {
  const w = initialiseLegacyMining(entries, seed);
  if (mapVersion < 2) return w;
  const pick = (salt: string, lo: number, hi: number) => lo + Math.floor(random(seed, salt) * (hi - lo + 1));
  const starts = [
    { x: pick('spawn0x', 2, 4), y: pick('spawn0y', 2, 4) },
    { x: pick('spawn1x', 19, 21), y: pick('spawn1y', 19, 21) },
    { x: pick('spawn2x', 19, 21), y: pick('spawn2y', 2, 4) },
    { x: pick('spawn3x', 2, 4), y: pick('spawn3y', 19, 21) },
    { x: pick('spawn4x', 2, 3), y: pick('spawn4y', 9, 14) },
    { x: pick('spawn5x', 20, 21), y: pick('spawn5y', 9, 14) },
    { x: pick('spawn6x', 9, 14), y: pick('spawn6y', 2, 3) },
    { x: pick('spawn7x', 9, 14), y: pick('spawn7y', 20, 21) },
  ];
  w.players.forEach((p, i) => Object.assign(p, starts[i]));
  w.bases = starts.map((p, i) => i < 6 ? { x: p.x + (p.x < 12 ? -2 : 2), y: p.y } : { x: p.x, y: p.y + (p.y < 12 ? -2 : 2) });
  w.clinics = [{ x: pick('clinic0x', 5, 9), y: pick('clinic0y', 7, 16) }, { x: pick('clinic1x', 14, 18), y: pick('clinic1y', 7, 16) }];
  const hub = { x: pick('richx', 10, 13), y: pick('richy', 10, 13) };
  const regions = [
    { x: pick('region0x', 2, 9), y: pick('region0y', 2, 9), zone: 0 },
    { x: pick('region1x', 14, 21), y: pick('region1y', 2, 9), zone: 1 },
    { x: pick('region2x', 2, 9), y: pick('region2y', 14, 21), zone: 2 },
    { x: pick('region3x', 14, 21), y: pick('region3y', 14, 21), zone: 3 },
  ];
  const palette = [0, 1, 2, 3].sort((a, b) => random(seed, `palette:${a}`) - random(seed, `palette:${b}`));
  w.tiles = [];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const p = { x, y }, central = distance(p, hub) < 7;
    const reserved = [...starts, ...w.bases, ...w.clinics].some(q => distance(p, q) <= 1);
    const r = random(seed, `tile:${x}:${y}`), v = random(seed, `value:${x}:${y}`), h = random(seed, `hazard:${x}:${y}`);
    const blocked = !reserved && r < .12;
    const vein = !blocked && r > (central ? .32 : .47) ? (central && r > .82 ? 2 : 1) : 0;
    const region = regions.slice().sort((a, b) => Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y))[0]!;
    w.tiles.push({ zone: palette[region.zone]!, blocked, vein, value: blocked ? 0 : vein ? 3 + Math.floor(v * (central ? 12 : 7)) : v > .75 ? 3 : 0,
      danger: !blocked && !reserved && h < .13 ? 'venom' : !blocked && !reserved && h < .27 ? 'snake' : !blocked && !reserved && h < .37 ? 'cave' : null, crown: false });
  }
  const crownPosition = { x: pick('crownx', 6, 17), y: pick('crowny', 6, 17) };
  if (mapVersion >= 3 && [...starts, ...w.bases, ...w.clinics].some(q => distance(q, crownPosition) <= 1)) {
    const candidates = Array.from({ length: 144 }, (_, i) => ({ x: 6 + i % 12, y: 6 + Math.floor(i / 12) }))
      .filter(p => [...starts, ...w.bases, ...w.clinics].every(q => distance(q, p) > 1))
      .sort((a, b) => random(seed, `crown-fallback:${key(a)}`) - random(seed, `crown-fallback:${key(b)}`));
    Object.assign(crownPosition, candidates[0]!);
  }
  const carve = (start: Position, horizontal: boolean) => {
    const p = { ...start };
    for (let step = 0; step < 48; step++) {
      tileAt(w, p).blocked = false;
      if (!distance(p, hub)) break;
      if ((horizontal && p.x !== hub.x) || p.y === hub.y) p.x += Math.sign(hub.x - p.x);
      else p.y += Math.sign(hub.y - p.y);
    }
  };
  [...starts, ...w.bases, ...w.clinics, crownPosition].forEach((p, i) => carve(p, random(seed, `corridor:${i}`) > .5));
  if (mapVersion >= 3) {
    // Independent samples decouple visible clues from guaranteed rewards.
    // Carving routes must not accidentally add deposits.
    w.tiles.forEach((tile, index) => {
      const p = { x: index % 24, y: Math.floor(index / 24) };
      const reserved = [...starts, ...w.bases, ...w.clinics].some(q => distance(p, q) <= 1);
      const central = distance(p, hub) < 7;
      const clue = random(seed, `deposit:${index}`);
      const yieldRoll = random(seed, `yield:${index}`);
      tile.vein = !tile.blocked && !reserved && clue < (central ? .34 : .18) ? (central && clue < .07 ? 2 : 1) : 0;
      tile.value = tile.blocked || reserved ? 0 : tile.vein
        ? yieldRoll < .78 ? 3 + Math.floor(random(seed, `amount:${index}`) * (central ? 12 : 7)) : 0
        : yieldRoll < .035 ? 2 + Math.floor(random(seed, `amount:${index}`) * 3) : 0;
    });
  }
  const crown = tileAt(w, crownPosition); crown.crown = true; crown.value = 35; crown.vein = 2;
  return w;
}
function passable(w: MiningWorld, p: Position) { return p.x >= 0 && p.y >= 0 && p.x < 24 && p.y < 24 && !tileAt(w, p).blocked && !w.excavations[key(p)]?.rubble; }
export function miningPath(w: MiningWorld, start: Position, end: Position): Position[] | null {
  if (!passable(w, end)) return null;
  const queue = [{ x: start.x, y: start.y }], visited = new Set([key(start)]), previous = new Map<string, Position>();
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    if (distance(p, end) === 0) {
      const result: Position[] = []; let current = p;
      while (key(current) !== key(start)) { result.unshift(current); current = previous.get(key(current))!; }
      return result;
    }
    for (const q of [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }]) {
      if (!passable(w, q) || visited.has(key(q))) continue;
      visited.add(key(q)); previous.set(key(q), p); queue.push(q);
    }
  }
  return null;
}
const nearest = (p: Position, targets: Position[]) => targets.slice().sort((a, b) => distance(p, a) - distance(p, b))[0]!;
export function validateMining(w: MiningWorld, agentId: string, sequence: number, command: MiningCommand) {
  const p = w.players.find(a => a.id === agentId);
  requireThat(p, 'NOT_PARTICIPANT', 'This agent is not a miner.', 403);
  requireThat(w.elapsedMs < MINING_MS && p.alive, 'MINER_INACTIVE', 'This miner can no longer act.');
  requireThat(sequence === p.sequence + 1 && sequence <= 20, 'STALE_SEQUENCE', 'Supply the miner’s next independent decision sequence (maximum 20).');
  const emergency = ['retreat', 'repel', 'treat'].includes(command.type);
  requireThat(emergency || (!p.job && w.elapsedMs >= p.nextDecisionAt), 'MINER_BUSY', 'The current job or decision cooldown has not finished.');
  if (['mine', 'inspect', 'recover', 'retreat', 'clear'].includes(command.type)) requireThat(command.target, 'TARGET_REQUIRED', 'Choose a map target.', 400);
  if (command.type === 'mine') requireThat(!w.excavations[key(command.target!)]?.depleted, 'DEPLETED', 'This site has already been excavated.');
  if (command.type === 'clear') requireThat(w.excavations[key(command.target!)]?.rubble && distance(p, command.target!) <= 1, 'NO_RUBBLE', 'Stand next to rubble to clear it.');
  else if (command.target) requireThat(miningPath(w, p, command.target) !== null, 'NO_ROUTE', 'No traversable route to that target.');
}
function startPhase(w: MiningWorld, p: Miner) {
  const j = p.job!;
  j.started = w.elapsedMs;
  if (j.path.length) {
    j.phase = 'walk'; j.from = { x: p.x, y: p.y }; j.duration = p.crown ? 1400 : p.cargo >= 16 ? 1100 : 750 + w.players.indexOf(p) % 3 * 100;
  } else { j.phase = j.type === 'mine' ? 'inspect' : 'work'; j.duration = j.type === 'mine' || j.type === 'inspect' ? 1500 : j.type === 'bank' ? 2500 : j.type === 'clear' ? 4000 : 1800; }
  j.until = w.elapsedMs + j.duration;
}
export function acceptMining(w: MiningWorld, agentId: string, sequence: number, raw: MiningCommand): MiningInput {
  const command = miningCommandSchema.parse(raw); validateMining(w, agentId, sequence, command);
  const p = w.players.find(a => a.id === agentId)!;
  const stations = command.type === 'bank' ? w.bases : command.type === 'treat' && !p.antidotes ? w.clinics : undefined;
  const destination = stations ? nearest(p, stations.filter(b => miningPath(w, p, b) !== null)) : command.target ?? { x: p.x, y: p.y };
  requireThat(destination, 'NO_ROUTE', 'No reachable extraction or treatment station.');
  p.sequence = sequence; p.nextDecisionAt = w.elapsedMs + 12_000 + w.players.indexOf(p) * 170;
  p.job = { type: command.type, target: destination, path: command.type === 'clear' ? [] : miningPath(w, p, destination) ?? [], phase: 'walk', until: 0, started: w.elapsedMs, from: { x: p.x, y: p.y }, duration: 0 };
  startPhase(w, p);
  emit(w, 'job', p, `${agentId} started ${command.type}`, agentId);
  return { at: w.elapsedMs, agentId, sequence, command };
}
function eliminate(w: MiningWorld, p: Miner, reason: string) {
  p.alive = false; p.health = 0; p.job = null;
  if (p.cargo) w.drops.push({ x: p.x, y: p.y, value: p.cargo, crown: p.crown });
  p.cargo = 0; p.crown = false; p.venomUntil = null;
  emit(w, 'eliminated', p, `${p.id} collapsed: ${reason}. Banked treasure is retained.`, p.id);
}
function inspect(w: MiningWorld, p: Miner, q: Position) {
  const tile = tileAt(w, q); p.known[key(q)] = { value: tile.value, danger: tile.danger, crown: tile.crown };
}
function finishWork(w: MiningWorld, p: Miner) {
  const j = p.job!, q = j.target, site = key(q), tile = tileAt(w, q);
  switch (j.type) {
    case 'mine': {
      if (w.excavations[site]?.depleted) break;
      w.excavations[site] = { depth: 3, depleted: true, crackUntil: tile.danger === 'cave' ? w.elapsedMs + 3000 : null, rubble: false };
      if (tile.crown) { p.crown = true; p.cargo += 35; emit(w, 'crown', p, `${p.id} found the Crown Diamond! Carrier location is public.`, p.id, 35); }
      else { const amount = Math.min(tile.value, Math.max(0, 24 - p.cargo)); p.cargo += amount; emit(w, amount ? 'treasure' : 'empty', p, amount ? `${p.id} unearthed ${amount} diamonds` : `${p.id} found an empty pocket`, p.id, amount); }
      if (tile.danger === 'snake' || tile.danger === 'venom') {
        w.snakes.push({ id: `s:${site}`, x: q.x, y: q.y, venomous: tile.danger === 'venom', health: 3, born: w.elapsedMs, nextAt: w.elapsedMs + 2000, phase: 'coil' });
        emit(w, 'snake', q, `${tile.danger === 'venom' ? 'A venomous snake' : 'A snake'} emerged from the excavation!`, p.id);
      }
      if (tile.danger === 'cave') emit(w, 'crack', q, 'The ground is cracking. Cave-in in three seconds!', p.id);
      break;
    }
    case 'inspect': for (let y = Math.max(0, q.y - 2); y <= Math.min(23, q.y + 2); y++) for (let x = Math.max(0, q.x - 2); x <= Math.min(23, q.x + 2); x++) inspect(w, p, { x, y }); emit(w, 'inspect', p, `${p.id} inspected the deposits`, p.id); break;
    case 'bank': if (p.cargo && w.bases.some(b => distance(p, b) === 0)) { const value = p.cargo; p.deposited += value; p.cargo = 0; const crown = p.crown; p.crown = false; emit(w, crown ? 'crown-bank' : 'bank', p, `${p.id} banked ${value} diamonds${crown ? ' including the Crown' : ''}`, p.id, value); } break;
    case 'treat': if (p.antidotes || w.clinics.some(b => distance(p, b) === 0)) { if (p.antidotes) p.antidotes--; p.venomUntil = null; p.health = Math.min(6, p.health + 2); emit(w, 'treated', p, `${p.id} treated the venom`, p.id); } break;
    case 'repel': for (const s of w.snakes.filter(s => distance(p, s) <= 2)) { s.health -= 3; emit(w, 'repel', s, `${p.id} drove off a snake`, p.id); } break;
    case 'clear': if (w.excavations[site]) { w.excavations[site]!.rubble = false; emit(w, 'clear', q, `${p.id} cleared a passage`, p.id); } break;
    case 'recover': { const dropped = w.drops.find(d => distance(p, d) === 0); if (dropped) { const amount = dropped.crown ? dropped.value : Math.min(dropped.value, Math.max(0, 24 - p.cargo)); p.cargo += amount; p.crown ||= dropped.crown; dropped.value -= amount; w.drops = w.drops.filter(d => d.value > 0); emit(w, 'recover', p, `${p.id} recovered ${amount} dropped diamonds`, p.id, amount); } break; }
  }
  p.job = null;
}
function stepMining(w: MiningWorld) {
  w.elapsedMs += MINING_STEP; w.round = w.elapsedMs / MINING_STEP;
  for (const p of w.players) {
    if (!p.alive) continue;
    if (p.venomUntil && w.elapsedMs >= p.venomUntil) { eliminate(w, p, 'untreated venom'); continue; }
    const j = p.job;
    if (!j) continue;
    if (j.type === 'mine' && j.phase === 'dig') {
      const existing = w.excavations[key(j.target)];
      if (!existing?.depleted) w.excavations[key(j.target)] = { depth: Math.min(2, Math.floor((w.elapsedMs - j.started) / j.duration * 3)), depleted: false, crackUntil: null, rubble: false };
    }
    if (w.elapsedMs < j.until) continue;
    if (j.phase === 'walk') {
      const next = j.path.shift()!;
      if (!passable(w, next)) { j.path = miningPath(w, p, j.target) ?? []; if (!j.path.length && distance(p, j.target)) { p.job = null; emit(w, 'blocked', p, `${p.id} needs a new route`, p.id); continue; } startPhase(w, p); continue; }
      p.x = next.x; p.y = next.y; startPhase(w, p);
    } else if (j.phase === 'inspect') {
      inspect(w, p, j.target); j.phase = 'dig'; j.started = w.elapsedMs; j.duration = 4500 + Math.floor(random(w.seed, `dig:${key(j.target)}`) * 4) * 500; j.until = w.elapsedMs + j.duration;
      emit(w, 'dig', p, `${p.id} started excavating`, p.id);
    } else finishWork(w, p);
  }
  for (const [site, excavation] of Object.entries(w.excavations)) if (excavation.crackUntil && w.elapsedMs >= excavation.crackUntil) {
    excavation.crackUntil = null; excavation.rubble = true;
    const [x, y] = site.split(',').map(Number), q = { x: x!, y: y! };
    emit(w, 'collapse', q, 'A cave-in blocked the passage.');
    for (const p of w.players.filter(p => p.alive && distance(p, q) === 0)) { p.health -= 3; p.job = null; if (p.health <= 0) eliminate(w, p, 'cave-in'); }
  }
  for (const s of w.snakes.filter(s => s.health > 0)) {
    if (w.elapsedMs < s.nextAt) continue;
    const p = w.players.filter(p => p.alive && distance(p, s) <= 5).sort((a, b) => distance(a, s) - distance(b, s))[0];
    if (!p || w.elapsedMs - s.born > 40_000) { s.health = 0; continue; }
    s.targetId = p.id;
    if (distance(p, s) <= 1) {
      if (s.phase !== 'strike') { s.phase = 'strike'; s.nextAt = w.elapsedMs + 1500; emit(w, 'rattle', s, 'A snake is preparing to strike!', p.id); }
      else { p.health -= s.venomous ? 2 : 1; if (s.venomous && !p.venomUntil) { p.venomUntil = w.elapsedMs + 30_000; emit(w, 'venom', p, `${p.id} is poisoned. Thirty seconds to treat it.`, p.id); } emit(w, 'bite', p, `${p.id} was bitten`, p.id); if (p.health <= 0) eliminate(w, p, 'snake bite'); s.phase = 'coil'; s.nextAt = w.elapsedMs + 4500; }
    } else {
      const route = miningPath(w, s, p); if (route?.length) { s.x = route[0]!.x; s.y = route[0]!.y; }
      s.phase = 'chase'; s.nextAt = w.elapsedMs + 1500;
    }
  }
  w.snakes = w.snakes.filter(s => s.health > 0);
  if (w.elapsedMs === MINING_MS) { for (const p of w.players) p.job = null; emit(w, 'finish', { x: 12, y: 12 }, 'Time is up. Only banked treasure counts.'); }
}
export function advanceMining(w: MiningWorld, elapsed: number, onFrame?: (frame: MiningPublic) => void) {
  requireThat(Number.isFinite(elapsed) && elapsed >= w.elapsedMs, 'CLOCK_REGRESSION', 'Mining clock cannot move backwards.');
  const end = Math.min(MINING_MS, Math.floor(elapsed / MINING_STEP) * MINING_STEP);
  while (w.elapsedMs < end) { stepMining(w); if (w.elapsedMs % 1000 === 0) onFrame?.(publicMining(w)); }
}
export function publicMining(w: MiningWorld): MiningPublic {
  const { seed: _, tiles, players, ...visible } = w;
  return structuredClone({ ...visible, tiles: tiles.map(({ zone, blocked, vein }) => ({ zone, blocked, vein })), players: players.map(({ known: _, nextDecisionAt: __, ...p }) => p) });
}
export function miningObservation(w: MiningWorld, id: string) {
  const p = w.players.find(p => p.id === id)!;
  const visible = publicMining(w);
  return { version: 2, elapsedMs: w.elapsedMs, durationMs: MINING_MS, self: structuredClone(p), bases: w.bases, clinics: w.clinics,
    terrain: visible.tiles.map(t => t.zone + t.vein * 4 + (t.blocked ? 16 : 0)), terrainEncoding: 'row-major 24x24; zone=n%4, vein=floor(n/4)%4, blocked=n>=16', excavations: w.excavations, snakes: w.snakes.filter(s => distance(s, p) <= 4), drops: w.drops.filter(d => distance(d, p) <= 4),
    competitors: w.players.filter(a => a.id !== id).map(a => ({ id: a.id, deposited: a.deposited, alive: a.alive, ...(a.crown ? { x: a.x, y: a.y, crown: true } : {}) })), legalJobs: ['mine', 'inspect', 'bank', 'recover', 'retreat', 'repel', 'treat', 'clear', 'wait'] };
}
export function miningBot(w: MiningWorld, id: string, strategy: string): MiningCommand {
  const p = w.players.find(p => p.id === id)!;
  if (p.venomUntil) return { type: 'treat' };
  if (w.snakes.some(s => distance(s, p) <= 2)) return { type: 'repel' };
  if (p.crown || p.cargo >= (strategy === 'defensive' ? 9 : 18) || p.cargo && (p.sequence >= 18 || MINING_MS - w.elapsedMs < 40_000)) return { type: 'bank' };
  if (p.sequence >= 19) return { type: 'wait' };
  const drop = w.drops.filter(d => distance(d, p) <= 5 && miningPath(w, p, d) !== null).sort((a, b) => b.value - a.value)[0];
  if (drop) return { type: 'recover', target: { x: drop.x, y: drop.y } };
  const candidates: { q: Position; score: number }[] = [];
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const q = { x, y }, t = tileAt(w, q), known = p.known[key(q)];
    if (!t.vein || !passable(w, q) || w.excavations[key(q)]?.depleted || w.players.some(a => a.id !== id && a.job?.type === 'mine' && distance(a.job.target, q) === 0)) continue;
    if (strategy === 'defensive' && known?.danger) continue;
    if ((distance(p, q) + distance(q, nearest(q, w.bases))) * 1500 + 10_000 > MINING_MS - w.elapsedMs) continue;
    const center = distance(q, { x: 12, y: 12 });
    const score = distance(p, q) + (strategy === 'aggressive' ? center * 2.1 : 0) - t.vein * 1.6 - (known?.value ?? 0) * .15 + random(w.seed, `${id}:${p.sequence}:${key(q)}`) * 4;
    candidates.push({ q, score });
  }
  for (const c of candidates.sort((a, b) => a.score - b.score).slice(0, 20)) if (miningPath(w, p, c.q)) return { type: 'mine', target: c.q };
  return p.cargo ? { type: 'bank' } : { type: 'wait' };
}
export function miningRanks(w: MiningWorld): number[] {
  const scores = [...new Set(w.players.map(p => p.deposited))].sort((a, b) => b - a);
  return w.players.map(p => scores.indexOf(p.deposited));
}
