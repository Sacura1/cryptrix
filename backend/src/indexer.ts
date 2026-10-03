import { randomUUID } from 'node:crypto';
import { decodeEventLog, type Hex } from 'viem';
import { escrowAbi, type ArcGateway } from './chain.js';
import { requireThat } from './domain.js';
import { Platform } from './platform.js';

const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
interface IndexedMatch { id: Hex; managed: boolean; status: 'open' | 'active' | 'settled' | 'cancelled'; game: number; stakeUnits: string; creator: string; rulesHash: Hex; participants: string[]; equipment: Record<string, Hex>; resultHash?: Hex; ranks?: readonly number[]; resolveDeadline?: number }
export class ChainIndexer {
  readonly holder = randomUUID();
  private running = false;
  private closing = false;
  private task?: Promise<void>;
  caughtUp = false;
  constructor(readonly platform: Platform, readonly chain: ArcGateway, readonly deploymentBlock: bigint, readonly batchSize = 500n) {
    requireThat(deploymentBlock >= 0n && batchSize > 0n && batchSize <= 2000n, 'INDEXER_CONFIG', 'Indexer needs a valid deployment block and bounded batch size.', 503);
  }
  async runOnce() {
    if (this.running || this.closing) return;
    this.running = true;
    this.task = this.batch().finally(() => { this.running = false; });
    await this.task;
  }
  private async batch() {
    const { store, now } = this.platform;
    const lease = `index:${this.chain.chainId}:${this.chain.escrow.toLowerCase()}`;
    if (!store.lease(lease, this.holder, now(), 120_000)) return;
    try {
      const address = this.chain.escrow.toLowerCase();
      const cursor = store.db.prepare('SELECT * FROM chain_cursors WHERE chain_id=? AND address=?').get(this.chain.chainId, address);
      if (cursor) {
        const previous = await this.chain.client.getBlock({ blockNumber: BigInt(String(cursor.block_number)) });
        requireThat(previous.hash?.toLowerCase() === String(cursor.block_hash).toLowerCase(), 'CHAIN_HISTORY_CHANGED', 'Finalized index cursor changed; refusing to silently rewrite financial history.', 503);
      }
      const latest = await this.chain.client.getBlock();
      requireThat(!cursor || latest.number >= BigInt(String(cursor.block_number)), 'INDEX_HEAD_BEHIND', 'RPC head is behind the finalized cursor.', 503);
      const from = cursor ? BigInt(String(cursor.block_number)) + 1n : this.deploymentBlock;
      if (from > latest.number) { await this.reconcile(); this.caughtUp = true; store.service('indexer', now()); return; }
      const to = from + this.batchSize - 1n < latest.number ? from + this.batchSize - 1n : latest.number;
      const [logs, last] = await Promise.all([
        this.chain.client.getLogs({ address: this.chain.escrow, fromBlock: from, toBlock: to }),
        this.chain.client.getBlock({ blockNumber: to }),
      ]);
      // Fetch blocks once per distinct log block, retaining canonical event timestamps.
      const blocks = new Map<string, { timestamp: number; hash: string | null }>();
      for (const number of [...new Set(logs.filter(l => l.blockNumber !== null).map(l => String(l.blockNumber)))]) {
        const block = await this.chain.client.getBlock({ blockNumber: BigInt(number) }); blocks.set(number, { timestamp: Number(block.timestamp) * 1000, hash: block.hash });
      }
      if (this.closing) return;
      store.transaction(() => {
        const owner = store.db.prepare('SELECT holder,expires_at FROM leases WHERE name=?').get(lease);
        requireThat(owner?.holder === this.holder && Number(owner.expires_at) > now(), 'INDEX_LEASE_LOST', 'A stale indexer cannot advance the cursor.');
        for (const log of logs.sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!)) {
          if (log.removed || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
          const block = blocks.get(String(log.blockNumber));
          requireThat(log.address.toLowerCase() === address && log.blockNumber >= from && log.blockNumber <= to && block && log.blockHash === block.hash, 'INDEX_LOG_INVALID', 'RPC returned a log outside the canonical escrow range.', 503);
          let event;
          try { event = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics }); } catch { continue; }
          const doc = { name: event.eventName, args: event.args, timestamp: block.timestamp, blockNumber: String(log.blockNumber), transactionHash: log.transactionHash, logIndex: log.logIndex };
          const inserted = store.db.prepare('INSERT OR IGNORE INTO chain_events VALUES(?,?,?,?,?,?)').run(this.chain.chainId, address, log.transactionHash.toLowerCase(), log.logIndex, String(log.blockNumber), json(doc));
          if (Number(inserted.changes)) this.apply(event.eventName, event.args as Record<string, any>);
        }
        store.db.prepare('INSERT INTO chain_cursors VALUES(?,?,?,?) ON CONFLICT(chain_id,address) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash').run(this.chain.chainId, address, String(to), last.hash);
      });
      await this.reconcile(); store.service('indexer', now());
      this.caughtUp = to === latest.number;
    } catch (error) { this.caughtUp = false; store.service('indexer', now(), 'INDEXER_FAILED'); throw error; }
    finally { store.releaseLease(lease, this.holder); }
  }
  private apply(name: string, args: Record<string, any>) {
    const { store } = this.platform;
    if (name === 'CreditClaimed') return; // Stored in the event ledger; never invent per-match allocation for aggregate claims.
    const id = String(args.id).toLowerCase() as Hex;
    const row = store.db.prepare('SELECT doc FROM chain_matches WHERE id=?').get(id);
    let match = row ? JSON.parse(String(row.doc)) as IndexedMatch : undefined;
    if (name === 'MatchCreated') {
      match = { id, managed: !!store.db.prepare('SELECT 1 FROM matches WHERE id=?').get(id), status: 'open', game: Number(args.game), stakeUnits: String(args.stake), creator: String(args.creator).toLowerCase(), rulesHash: args.rulesHash, participants: [], equipment: {} };
    }
    requireThat(match, 'INDEX_EVENT_ORDER', 'Escrow event appeared before its creation; check the deployment block.', 503);
    if (name === 'MatchJoined') { requireThat(Number(args.slot) === match.participants.length, 'INDEX_SLOT', 'Entrant slot is out of canonical order.', 503); match.participants.push(String(args.entrant).toLowerCase()); }
    if (name === 'EquipmentCommitted') match.equipment[String(args.entrant).toLowerCase()] = args.commitment;
    if (name === 'MatchStarted') { match.status = 'active'; match.resolveDeadline = Number(args.resolveDeadline) * 1000; }
    if (name === 'MatchSettled') { match.status = 'settled'; match.resultHash = args.resultHash; match.ranks = args.rankGroups; }
    if (name === 'MatchCancelled') match.status = 'cancelled';
    store.db.prepare('INSERT INTO chain_matches VALUES(?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(id, json(match));
  }
  private async reconcile() {
    // Ledger records every match, including unmanaged direct contract creations.
    // Only offers with a locally committed seed/rules are eligible for this platform's engine.
    const rows = this.platform.store.db.prepare("SELECT doc FROM matches WHERE mode='paid' AND (status IN ('funding','open','active') OR (status='finished' AND coalesce(json_extract(doc,'$.settlement'),'pending')!='settled'))").all();
    let failed = false;
    for (const row of rows) {
      if (this.closing) break;
      const match = JSON.parse(String(row.doc));
      try { await this.platform.sync(match.id); }
      catch { failed = true; this.platform.store.audit('chain-reconciliation-required', match.id, { code: 'SYNC_FAILED' }, this.platform.now()); }
    }
    this.platform.store.service('reconciliation', this.platform.now(), failed ? 'SYNC_FAILED' : undefined);
    requireThat(!failed, 'RECONCILIATION_FAILED', 'One or more managed matches need reconciliation.', 503);
  }
  async stop() { this.closing = true; await this.task; }
}
