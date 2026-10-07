import { createHash } from 'node:crypto';
import type { MiningRecording } from './mining.js';

export const GAME_IDS = ['flux-duel', 'cache-rush'] as const;
export type GameId = typeof GAME_IDS[number];
export const MIN_STAKE = 500_000;
export const MAX_STAKE = 5_000_000;
export const LEGACY_STAKES = ['1', '2', '3', '4', '5'] as const;
export const STAKES = ['0.5', ...LEGACY_STAKES] as const;
export const MAX_OPEN_ROOMS = 5;
export const RUSH_STAKE = MIN_STAKE;
export const MAX_ROUNDS = 20;
export const ROUND_MS = 30_000;
export const FILL_MS = 15 * 60_000;
export const PLAY_SECONDS = 3600;
// Escrow v4 deducts this fee before allocating prizes; replay amounts remain gross.
export const PLATFORM_FEE_BPS = 100;

export class Fault extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function requireThat(value: unknown, code: string, message: string, status = 409): asserts value {
  if (!value) throw new Fault(status, code, message);
}

// USDC at the ERC-20 interface has six decimals. Never parse money through floats.
export function parseUsdc(value: string): number {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value), 'INVALID_AMOUNT', 'Use a decimal USDC string with at most six decimal places.', 400);
  const [whole = '0', fraction = ''] = value.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  requireThat(units <= BigInt(Number.MAX_SAFE_INTEGER), 'INVALID_AMOUNT', 'Amount is too large.', 400);
  return Number(units);
}
export function formatUsdc(units: number): string {
  requireThat(Number.isSafeInteger(units) && units >= 0, 'INVALID_AMOUNT', 'Invalid USDC units.', 400);
  return `${Math.floor(units / 1_000_000)}.${String(units % 1_000_000).padStart(6, '0')}`;
}
export function stakeFor(game: GameId, value?: string): number {
  const stake = value === undefined ? (game === 'cache-rush' ? RUSH_STAKE : MIN_STAKE) : parseUsdc(value);
  requireThat(stake >= MIN_STAKE && stake <= MAX_STAKE && (stake === MIN_STAKE || stake % 1_000_000 === 0), 'STAKE_RANGE', 'Choose a stake of 0.5, 1, 2, 3, 4, or 5 USDC.', 400);
  return stake;
}
export function capacity(game: GameId): number { return game === 'flux-duel' ? 2 : 8; }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown): `0x${string}` { return `0x${createHash('sha256').update(canonical(value)).digest('hex')}`; }
export const legacyRules = (game: GameId) => ({
  version: 1, game, capacity: capacity(game), maxRounds: MAX_ROUNDS, roundMs: ROUND_MS,
  stakeMin: '0.100000', stakeMax: '10.000000',
  entryStake: game === 'cache-rush' ? '1.000000' : 'creator-selected',
  payoutsBps: game === 'cache-rush' ? [6000, 2500, 1500] : [10000],
  ties: 'Share prizes for occupied positions; micro-unit remainder follows original entry order.',
  duel: game === 'flux-duel' ? { board: 7, health: 12, energy: 6, equipmentBudget: 6, objective: [3, 3], timeoutAction: 'wait' } : undefined,
  rush: game === 'cache-rush' ? { board: 11, relics: 24, cargoCapacity: 5, heavyCargo: 3, vision: 2, scanVision: 4, timeoutAction: 'wait' } : undefined,
});

export const rules = (game: GameId, protocolVersion = 3) => protocolVersion === 1 ? legacyRules(game) : ({ ...legacyRules(game), protocolVersion, stakeMin: protocolVersion === 2 ? '1.000000' : '0.500000', stakeMax: '5.000000', stakes: protocolVersion === 2 ? LEGACY_STAKES : STAKES, entryStake: 'creator-selected' });

// rankGroups are dense group IDs in original participant order, not ordinal positions.
export function payoutUnits(game: GameId, stake: number, rankGroups: number[], feeBps = 0): number[] {
  requireThat(rankGroups.length === capacity(game), 'INVALID_RANKS', 'Wrong rank count.');
  const groups = [...new Set(rankGroups)].sort((a, b) => a - b);
  requireThat(groups.every((g, i) => g === i), 'INVALID_RANKS', 'Rank groups must start at zero without gaps.');
  requireThat(Number.isInteger(feeBps) && feeBps >= 0 && feeBps < 10000, 'INVALID_FEE', 'Invalid prize fee.');
  const grossPot = stake * rankGroups.length;
  const pot = grossPot - Math.floor(grossPot * feeBps / 10000);
  const prizes = game === 'flux-duel' ? [pot] : [Math.floor(pot * 60 / 100), Math.floor(pot * 25 / 100), pot - Math.floor(pot * 60 / 100) - Math.floor(pot * 25 / 100)];
  const payouts = rankGroups.map(() => 0);
  let position = 0;
  for (const group of groups) {
    const members = rankGroups.flatMap((g, i) => g === group ? [i] : []);
    const prize = prizes.slice(position, position + members.length).reduce((a, b) => a + b, 0);
    members.forEach((member, i) => { payouts[member] = Math.floor(prize / members.length) + (i < prize % members.length ? 1 : 0); });
    position += members.length;
  }
  return payouts;
}

export interface Agent {
  id: string; wallet: string; name: string; createdAt: number;
}
export type MatchStatus = 'funding' | 'open' | 'active' | 'finished' | 'cancelled';
export interface Entry { agentId: string; wallet: string; equipment: Equipment; equipmentSalt?: string }
export function equipmentCommitment(equipment: Equipment, equipmentSalt?: string) {
  if (equipmentSalt !== undefined) requireThat(/^0x[0-9a-f]{64}$/.test(equipmentSalt), 'EQUIPMENT_SALT', 'Equipment salt must contain 32 bytes of lowercase hex.', 400);
  return digest(equipmentSalt === undefined ? equipment : { equipment, equipmentSalt });
}
// Legacy stored intents contain only gear. New intents preserve a random salt as private state.
export function readEquipmentIntent(value: string): { equipment: Equipment; equipmentSalt?: string } {
  const parsed = JSON.parse(value);
  return parsed.equipment ? parsed : { equipment: parsed };
}
export interface Equipment { attack: number; armor: number; sensor: number }
export interface Position { x: number; y: number }
export interface DuelPlayer extends Position { id: string; health: number; energy: number; objective: number; equipment: Equipment; aim: number; intel: boolean }
export interface RushPlayer extends Position { id: string; cargo: number; deposited: number; seen: Record<string, { value: number; round: number }>; slowed: boolean }
export interface DuelState { game: 'flux-duel'; round: number; players: DuelPlayer[] }
export interface RushState { game: 'cache-rush'; round: number; players: RushPlayer[]; relics: Record<string, number>; bases: Position[]; hazards: Position[] }
export type GameState = DuelState | RushState;
export type Action = { type: 'move'; direction: 'north' | 'south' | 'east' | 'west' } | { type: 'attack' | 'shield' | 'scan' | 'recharge' | 'wait' | 'collect' | 'deposit' };
export interface RoundRecord { round: number; actions: Record<string, Action>; events: string[]; state: GameState }
export interface Match {
  title?: string;
  protocolVersion?: 2 | 3; engineVersion?: 2; miningMapVersion?: 2 | 3; mining?: MiningRecording;
  id: `0x${string}`; game: GameId; mode: 'practice' | 'paid'; status: MatchStatus;
  creatorId: string; stake: number; fundingDeadline?: number; fillDeadline: number; createdAt: number;
  seed: string; commitment: `0x${string}`; rulesHash: `0x${string}`; entries: Entry[];
  pending: Record<string, Action>; state?: GameState; roundDeadline?: number;
  history: RoundRecord[]; ranks?: number[]; payouts?: number[]; resultHash?: `0x${string}`;
  chainStatus?: number; chainResolveDeadline?: number; settlement?: 'pending' | 'settled' | 'refund-claimable';
  chainParticipants?: string[]; blockedEntries?: string[];
}
