function setting(name: string, fallback: number, max: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
export const DAILY_GAMES = setting('GAMES_PER_DAY', 10, 100);
export const HOSTED_GAMES = Math.min(DAILY_GAMES, setting('HOSTED_GAMES_PER_DAY', 10, 100));
export const HOSTED_REQUESTS = setting('HOSTED_REQUESTS_PER_DAY', HOSTED_GAMES * 20, 2000);
export const MODEL_TOKEN_ALLOWANCE = setting('HOSTED_TOKENS_PER_DAY', 1000000, 10000000);
export function readyAgents<T extends { id: string; createdAt: number }>(agents: T[], usage: (id: string) => { games: number }): T[] {
  return agents.slice().sort((a, b) => usage(a.id).games - usage(b.id).games || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
