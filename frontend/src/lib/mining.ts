export interface Point {
  x: number;
  y: number;
}
export interface MineJob {
  type: string;
  target: Point;
  path: Point[];
  phase: 'walk' | 'inspect' | 'dig' | 'work';
  until: number;
  started: number;
  from: Point;
  duration: number;
}
export interface Miner extends Point {
  id: string;
  health: number;
  cargo: number;
  deposited: number;
  crown: boolean;
  alive: boolean;
  antidotes: number;
  venomUntil: number | null;
  sequence: number;
  job: MineJob | null;
}
export interface MineEvent extends Point {
  id: number;
  at: number;
  kind: string;
  agentId?: string;
  text: string;
  value?: number;
}
export interface MineState {
  game: 'cache-rush';
  version: 2;
  round: number;
  elapsedMs: number;
  durationMs: number;
  board: number;
  tiles: { zone: number; blocked: boolean; vein: number }[];
  players: Miner[];
  bases: Point[];
  clinics: Point[];
  excavations: Record<
    string,
    { depth: number; depleted: boolean; crackUntil: number | null; rubble: boolean }
  >;
  snakes: (Point & {
    id: string;
    venomous: boolean;
    health: number;
    born: number;
    nextAt: number;
    phase: string;
    targetId?: string;
  })[];
  drops: (Point & { value: number; crown: boolean })[];
  events: MineEvent[];
  eventSequence: number;
}
export interface MineReplay {
  version: 2;
  initialState: MineState;
  frames: Omit<MineState, 'tiles'>[];
  ranks: number[];
  resultHash: string;
  rulesHash: string;
  seedCommitment: string;
}
export const minerColors = [
  '#ef8e32',
  '#fcf0c8',
  '#55cfac',
  '#fa6b51',
  '#ffd65c',
  '#48cbd3',
  '#dfaa79',
  '#b7ec4c',
];
export const timeLabel = (ms: number) =>
  `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, '0')}`;
export function replayMine(replay: MineReplay, elapsed: number): MineState {
  const index = Math.min(replay.frames.length - 1, Math.floor(elapsed / 1000) - 1);
  const frame = index >= 0 ? replay.frames[index] : replay.initialState;
  return { ...frame, tiles: replay.initialState.tiles };
}
export function minerPosition(p: Miner, elapsed: number): Point {
  const j = p.job;
  if (!j || j.phase !== 'walk' || !j.path.length) return p;
  const progress = Math.max(0, Math.min(1, (elapsed - j.started) / j.duration));
  return { x: p.x + (j.path[0].x - p.x) * progress, y: p.y + (j.path[0].y - p.y) * progress };
}
export function eventText(event: MineEvent, names: Record<string, string>): string {
  const text = Object.entries(names).reduce(
    (text, [id, name]) => text.replaceAll(id, name),
    event.text,
  );
  const name =
    event.agentId && Object.hasOwn(names, event.agentId) ? names[event.agentId] : undefined;
  if (!name || event.text.includes(event.agentId!)) return text;
  if (event.kind === 'snake')
    return `${name} uncovered ${event.text.includes('venomous') ? 'a venomous snake' : 'a snake'}!`;
  if (event.kind === 'rattle') return `A snake is preparing to strike ${name}!`;
  if (event.kind === 'crack') return `${name} disturbed unstable ground. Cave-in in three seconds!`;
  return `${name}: ${text}`;
}
export function eventSubject(
  event: MineEvent,
  players: Pick<Miner, 'id'>[],
  names: Record<string, string>,
) {
  if (!event.agentId) return undefined;
  const index = players.findIndex((p) => p.id === event.agentId);
  if (index < 0) return undefined;
  return { id: event.agentId, name: names[event.agentId] || `Miner ${index + 1}`, index };
}
export function mineHighlight(events: MineEvent[], elapsed: number) {
  const priority: Record<string, number> = {
    crown: 10,
    'crown-bank': 9,
    venom: 8,
    eliminated: 7,
    collapse: 6,
    snake: 5,
    bite: 4,
    crack: 4,
    treated: 3,
    bank: 2,
    treasure: 1,
    recover: 1,
    finish: 11,
  };
  return events
    .filter((e) => e.at <= elapsed && e.at > elapsed - 5500 && priority[e.kind])
    .sort((a, b) => priority[b.kind] - priority[a.kind] || b.at - a.at)[0];
}
