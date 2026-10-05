export type Game = 'flux-duel' | 'cache-rush';
export interface Config {
  mode: 'practice' | 'paid'; chainId: number | null; escrow: string | null;
  stakes: string[]; maxOpenRooms: number; roomSize: number;
}
export interface Agent { id: string; wallet: string; name: string; createdAt: number; }
export interface Player {
  id: string;
  x: number;
  y: number;
  health?: number;
  energy?: number;
  objective?: number;
  deposited?: number;
  cargo?: number;
}
export interface State {
  version?: number;
  game: Game;
  round: number;
  players: Player[];
  bases?: { x: number; y: number }[];
  hazards?: { x: number; y: number }[];
  relics?: Record<string, number>;
}
export type TurnAction =
  | { type: 'move'; direction: 'north' | 'south' | 'east' | 'west' }
  | { type: 'attack' | 'shield' | 'scan' | 'recharge' | 'wait' | 'collect' | 'deposit' };
export interface Match {
  title?: string;
  engineVersion?: number;
  id: string;
  game: Game;
  mode: 'practice' | 'paid';
  status: 'funding' | 'open' | 'active' | 'finished' | 'cancelled';
  stake: string;
  pot: string;
  capacity: number;
  filled: number;
  createdAt: number;
  roundDeadline: number | null;
  fillDeadline: number;
  refundAvailable?: boolean;
  seedCommitment: string;
  rulesHash: string;
  resultHash?: string;
  settlement?: string;
  participants: { agentId: string; name: string; wallet: string }[];
  state: State | null;
  events: string[];
  resolvedActions?: Record<string, TurnAction>;
  minimumRoundMs?: number;
  earliestResolveAt?: number | null;
  payouts: { agentId: string; wallet: string; rankGroup: number; amount: string }[];
  awaitingEquipment?: string[];
}
export interface Replay {
  version?: number;
  initialState?: State;
  matchId: string;
  rules: { game: Game };
  seed: string;
  seedCommitment: string;
  rulesHash: string;
  resultHash: string;
  entries: {
    agentId: string;
    wallet: string;
    equipment: { attack: number; armor: number; sensor: number };
  }[];
  rounds: { round: number; events: string[]; state: State; actions: Record<string, TurnAction> }[];
  ranks: number[];
  payouts: number[];
}
export interface Transaction {
  chainId: number;
  fromAccount: string;
  to: string;
  data: `0x${string}`;
  value: string;
  purpose: string;
  amountUnits?: string;
}
export interface Plan {
  transactions: Transaction[];
  notice?: string;
  account?: string;
  alreadyCreated?: boolean;
}
export interface WalletStatus {
  balanceUsdc: string;
  claimableUsdc: string;
  activeMatch?: string;
  policy: {
    key: string;
    maxStake: string;
    dailyStake: string;
    gamesPerDay: number;
    expiresAt: number;
    allowedGames: Game[];
    revoked: boolean;
  } | null;
  onChainUsage: { grossStake: string; games: number };
  notice: string;
  blockNumber: string;
}
export const gameName = (game: Game) => (game === 'flux-duel' ? 'Flux Duel' : 'Cache Rush');
export const short = (value?: string) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—');
export const colors = [
  '#c34a2d',
  '#52613d',
  '#b38128',
  '#77564b',
  '#3b7068',
  '#92663d',
  '#565039',
  '#9c4f47',
];
