import { formatUnits } from 'viem';
import { payoutUnits } from './domain.js';
import type { Platform } from './platform.js';

interface Receipt { transactionHash: string; amount: string; allocatedAmount: string; blockNumber: string }
interface Credit { matchId: string; wallet: string; amount: bigint; remaining: bigint; receipts: Receipt[] }
interface LedgerMatch { id: string; game: 'cache-rush' | 'flux-duel'; stake: number; wallets: string[]; started: boolean; settlementHash?: string }
interface Ledger { matches: Map<string, LedgerMatch>; credits: Credit[] }

/** Public summaries use indexed escrow receipts, never queued payment jobs. */
export class PublicArena {
  private cache?: { key: string; ledger: Ledger };
  constructor(private readonly platform: Platform) {}
  private ledger(): Ledger {
    const { chain, store } = this.platform;
    if (!chain) return { matches: new Map(), credits: [] };
    const params = [chain.chainId, chain.escrow.toLowerCase()] as const;
    const revision = store.db.prepare('SELECT count(*) AS count, max(rowid) AS last FROM chain_events WHERE chain_id=? AND address=?').get(...params)!;
    const key = `${params.join(':')}:${revision.count}:${revision.last}`;
    if (this.cache?.key === key) return this.cache.ledger;
    const matches = new Map<string, LedgerMatch>(), credits: Credit[] = [];
    const wallets = new Map<string, Credit[]>();
    const add = (match: LedgerMatch, wallet: string, amount: bigint) => {
      if (amount === 0n) return;
      const credit = { matchId: match.id, wallet, amount, remaining: amount, receipts: [] };
      credits.push(credit);
      const queue = wallets.get(wallet) ?? [];
      queue.push(credit); wallets.set(wallet, queue);
    };
    const rows = store.db.prepare('SELECT doc FROM chain_events WHERE chain_id=? AND address=? ORDER BY CAST(block_number AS INTEGER), log_index').all(...params);
    for (const row of rows) {
      const event = JSON.parse(String(row.doc)), args = event.args;
      if (event.name === 'CreditClaimed') {
        let remaining = BigInt(args.amount);
        // Claims withdraw aggregate wallet credits. FIFO is a display convention,
        // not a match identifier embedded in the onchain transfer.
        for (const credit of wallets.get(String(args.account).toLowerCase()) ?? []) {
          if (remaining === 0n) break;
          const amount = remaining < credit.remaining ? remaining : credit.remaining;
          if (amount === 0n) continue;
          credit.remaining -= amount; remaining -= amount;
          credit.receipts.push({ transactionHash: event.transactionHash, amount: formatUnits(BigInt(args.amount), 6), allocatedAmount: formatUnits(amount, 6), blockNumber: event.blockNumber });
        }
        continue;
      }
      const id = String(args.id).toLowerCase();
      if (event.name === 'MatchCreated') matches.set(id, { id, game: Number(args.game) === 0 ? 'flux-duel' : 'cache-rush', stake: Number(args.stake), wallets: [], started: false });
      const match = matches.get(id);
      if (!match) continue;
      if (event.name === 'MatchJoined') match.wallets.push(String(args.entrant).toLowerCase());
      if (event.name === 'MatchStarted') match.started = true;
      if (event.name === 'MatchSettled') {
        match.settlementHash = event.transactionHash;
        payoutUnits(match.game, match.stake, args.rankGroups.map(Number)).forEach((amount, index) => add(match, match.wallets[index]!, BigInt(amount)));
      }
      if (event.name === 'MatchCancelled') for (const wallet of match.wallets) add(match, wallet, BigInt(match.stake));
    }
    const ledger = { matches, credits }; this.cache = { key, ledger }; return ledger;
  }
  transfers(id: string) {
    const match = this.platform.store.match(id), ledger = this.ledger();
    return {
      chainId: this.platform.chain?.chainId ?? null, settlementHash: ledger.matches.get(id.toLowerCase())?.settlementHash ?? null,
      payouts: (match.payouts ?? []).map((amount, index) => {
        const entry = match.entries[index]!;
        const credit = ledger.credits.find(c => c.matchId === id.toLowerCase() && c.wallet === entry.wallet.toLowerCase());
        return { agentId: entry.agentId, wallet: entry.wallet, amount: formatUnits(BigInt(amount), 6),
          transferred: credit ? formatUnits(credit.amount - credit.remaining, 6) : '0',
          status: match.mode === 'practice' ? 'simulated' : amount === 0 ? 'no-prize' : !credit ? 'settlement-pending' : credit.remaining === 0n ? 'confirmed' : credit.remaining < credit.amount ? 'partial' : 'transfer-pending',
          receipts: credit?.receipts ?? [] };
      }),
      notice: 'Claims can combine games and refunds. Receipts are matched to game credits in settlement order; onchain claims identify the recipient wallet, not an individual game.',
    };
  }
  stats() {
    const { store, mode, chain } = this.platform;
    const matches = store.db.prepare('SELECT doc FROM matches WHERE mode=?').all(mode).map(row => JSON.parse(String(row.doc)));
    const ledger = this.ledger();
    let total = 0n, entries = 0, played = 0;
    const competitors = new Set<string>();
    for (const match of matches) {
      const record = ledger.matches.get(match.id.toLowerCase());
      const funded = mode === 'paid' ? record?.wallets ?? [] : match.entries.map((e: { wallet: string }) => e.wallet.toLowerCase());
      total += BigInt(mode === 'paid' ? record?.stake ?? 0 : match.stake) * BigInt(funded.length); entries += funded.length;
      for (const wallet of funded) competitors.add(wallet);
      if (mode === 'paid' ? record?.started : ['active', 'finished'].includes(match.status)) played++;
    }
    return { mode, chainId: chain?.chainId ?? null, updatedAt: this.platform.now(), scope: 'Recorded games in the current deployment',
      gamesPlayed: played, gamesCompleted: matches.filter(m => m.status === 'finished').length,
      agents: Number(store.db.prepare('SELECT count(*) AS n FROM agents').get()!.n), competingAgents: competitors.size,
      liveGames: matches.filter(m => m.status === 'active').length, openRooms: matches.filter(m => m.status === 'open').length,
      fundedEntries: entries, totalStakedUsdc: formatUnits(total, 6), averageStakeUsdc: formatUnits(entries ? total / BigInt(entries) : 0n, 6),
      notice: 'Total staked counts confirmed entries, including rooms later refunded. Average stake is per funded entry. Practice games are kept separate.' };
  }
}
