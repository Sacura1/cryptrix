import { NeonPersistence } from './persistence.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Agent, Match } from './domain.js';
import { digest, requireThat } from './domain.js';
export const DATABASE_VERSION = 3;

export class Store {
  readonly db: DatabaseSync;
  persistence?: NeonPersistence;
  static async open(path?: string, url?: string, namespace = 'backend:testnet'): Promise<Store> {
    if (!url) return new Store(path);
    const persistence = await NeonPersistence.open(url, namespace);
    const store = new Store(persistence.path);
    try { await persistence.attach(store.db); store.persistence = persistence; return store; }
    catch (error) { store.db.close(); await persistence.close(); persistence.cleanup(); throw error; }
  }
  get healthy(): boolean { return this.persistence?.healthy ?? true; }
  async flush(): Promise<void> { await this.persistence?.flush(); }
  async shutdown(): Promise<void> { await this.persistence?.close(); this.close(); this.persistence?.cleanup(); }

  private readonly changeListeners = new Set<(matchId?: string) => void>();
  onChange(listener: (matchId?: string) => void): void { this.changeListeners.add(listener); }
  private changed(matchId?: string): void { for (const listener of this.changeListeners) listener(matchId); }
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > DATABASE_VERSION) { this.db.close(); requireThat(false, 'DATABASE_VERSION', 'Database was created by a newer backend; refusing to downgrade.', 503); }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, game TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS match_discovery ON matches(status, mode, game, created_at);
      CREATE TABLE IF NOT EXISTS usage(agent_id TEXT NOT NULL, day INTEGER NOT NULL, mode TEXT NOT NULL, stake INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id, day, mode));
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, scope TEXT NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS intents(match_id TEXT NOT NULL, agent_id TEXT NOT NULL, expires_at INTEGER NOT NULL, equipment TEXT NOT NULL, PRIMARY KEY(match_id, agent_id));
      CREATE TABLE IF NOT EXISTS idempotency(actor TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor, key));
      CREATE TABLE IF NOT EXISTS model_usage(agent_id TEXT NOT NULL, day INTEGER NOT NULL, mode TEXT NOT NULL, allowance INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id,day,mode));
      CREATE TABLE IF NOT EXISTS model_jobs(id TEXT PRIMARY KEY, match_id TEXT NOT NULL, agent_id TEXT NOT NULL, round INTEGER NOT NULL, lease_until INTEGER NOT NULL, status TEXT NOT NULL, outcome TEXT, memory TEXT NOT NULL DEFAULT '', UNIQUE(match_id,agent_id,round));
      CREATE INDEX IF NOT EXISTS model_memory ON model_jobs(match_id,agent_id,round);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', raw_tx TEXT, unsigned_tx TEXT, reserved_gas TEXT, fee_day INTEGER, sender TEXT, nonce INTEGER, hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS transaction_nonce ON jobs(sender,nonce) WHERE raw_tx IS NOT NULL;
      CREATE INDEX IF NOT EXISTS runnable_jobs ON jobs(status,next_at,lease_until);
      CREATE TABLE IF NOT EXISTS chain_cursors(chain_id INTEGER NOT NULL, address TEXT NOT NULL, block_number TEXT NOT NULL, block_hash TEXT NOT NULL, PRIMARY KEY(chain_id,address));
      CREATE TABLE IF NOT EXISTS chain_events(chain_id INTEGER NOT NULL,address TEXT NOT NULL,tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,block_number TEXT NOT NULL,doc TEXT NOT NULL, PRIMARY KEY(chain_id,address,tx_hash,log_index));
      CREATE TABLE IF NOT EXISTS chain_matches(id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,subject TEXT NOT NULL,details TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS service_status(name TEXT PRIMARY KEY,last_success INTEGER,failures INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS entry_accounting(match_id TEXT NOT NULL,wallet TEXT NOT NULL,agent_id TEXT NOT NULL,stake INTEGER NOT NULL,entered_at INTEGER NOT NULL,canonical INTEGER NOT NULL,PRIMARY KEY(match_id,wallet));
      COMMIT;
    `);
    // Additive migration supports existing v1 databases without dropping state.
    this.db.exec('BEGIN IMMEDIATE');
    const jobColumns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map(row => String(row.name)));
    for (const [name, type] of [['unsigned_tx', 'TEXT'], ['reserved_gas', 'TEXT'], ['fee_day', 'INTEGER']]) if (!jobColumns.has(name!)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS reserved_nonce ON jobs(sender,nonce) WHERE unsigned_tx IS NOT NULL; PRAGMA user_version=${DATABASE_VERSION}; COMMIT;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); this.changed(); throw error; }
  }
  idempotent<T>(actor: string, key: string, request: unknown, fn: () => T): T {
    requireThat(/^[a-zA-Z0-9._:-]{8,128}$/.test(key), 'IDEMPOTENCY_REQUIRED', 'Supply an Idempotency-Key of 8–128 characters.', 400);
    return this.transaction(() => {
      const fingerprint = digest(request);
      const previous = this.db.prepare('SELECT fingerprint, response FROM idempotency WHERE actor=? AND key=?').get(actor, key) as { fingerprint: string; response: string } | undefined;
      if (previous) {
        requireThat(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different request.');
        return JSON.parse(previous.response) as T;
      }
      const response = fn();
      this.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(actor, key, fingerprint, JSON.stringify(response));
      return response;
    });
  }
  agent(id: string): Agent {
    const row = this.db.prepare('SELECT doc FROM agents WHERE id=?').get(id) as { doc: string } | undefined;
    requireThat(row, 'AGENT_NOT_FOUND', 'Agent not found.', 404);
    return JSON.parse(row.doc) as Agent;
  }
  agents(owner?: string): Agent[] {
    const rows = owner ? this.db.prepare('SELECT doc FROM agents WHERE owner=?').all(owner) : this.db.prepare('SELECT doc FROM agents').all();
    return rows.map(row => JSON.parse(String(row.doc)) as Agent);
  }
  saveAgent(agent: Agent): void {
    this.db.prepare('INSERT INTO agents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,doc=excluded.doc').run(agent.id, agent.owner, JSON.stringify(agent));
    this.changed();
  }
  match(id: string): Match {
    const row = this.db.prepare('SELECT doc FROM matches WHERE id=?').get(id) as { doc: string } | undefined;
    requireThat(row, 'MATCH_NOT_FOUND', 'Match not found.', 404);
    return JSON.parse(row.doc) as Match;
  }
  matches(status?: string, limit = 100, offset = 0): Match[] {
    const rows = status ? this.db.prepare('SELECT doc FROM matches WHERE status=? ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(status, limit, offset) : this.db.prepare('SELECT doc FROM matches ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(limit, offset);
    return rows.map(row => JSON.parse(String(row.doc)) as Match);
  }
  outstanding(): Match[] {
    return this.db.prepare("SELECT doc FROM matches WHERE status IN ('funding','open','active')").all().map(row => JSON.parse(String(row.doc)) as Match);
  }
  saveMatch(match: Match): void {
    this.db.prepare('INSERT INTO matches VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,doc=excluded.doc').run(match.id, match.game, match.status, match.mode, match.createdAt, JSON.stringify(match));
    this.changed(match.id);
  }
  usage(agentId: string, mode: string, now: number): { stake: number; games: number; requests: number } {
    const row = this.db.prepare('SELECT stake,games,requests FROM usage WHERE agent_id=? AND day=? AND mode=?').get(agentId, Math.floor(now / 86_400_000), mode);
    return row ? { stake: Number(row.stake), games: Number(row.games), requests: Number(row.requests) } : { stake: 0, games: 0, requests: 0 };
  }
  use(agentId: string, mode: string, now: number, stake: number, games = 1, requests = 0): void {
    this.db.prepare(`INSERT INTO usage VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id,day,mode) DO UPDATE SET stake=stake+excluded.stake,games=games+excluded.games,requests=requests+excluded.requests`).run(agentId, Math.floor(now / 86_400_000), mode, stake, games, requests);
  }
  lease(name: string, holder: string, now: number, ttl: number): boolean {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT holder,expires_at,fence FROM leases WHERE name=?').get(name);
      if (existing && existing.holder !== holder && Number(existing.expires_at) > now) return false;
      const fence = Number(existing?.fence ?? 0) + (existing?.holder === holder && Number(existing.expires_at) > now ? 0 : 1);
      this.db.prepare('INSERT INTO leases VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at,fence=excluded.fence').run(name, holder, now + ttl, fence);
      return true;
    });
  }
  bookEntry(matchId: string, wallet: string, agentId: string, stake: number, enteredAt: number, canonical: boolean, alreadyAccounted = false) {
    const row = this.db.prepare('SELECT * FROM entry_accounting WHERE match_id=? AND wallet=?').get(matchId, wallet);
    if (!row) {
      if (!alreadyAccounted) this.use(agentId, 'paid', enteredAt, stake);
      this.db.prepare('INSERT INTO entry_accounting VALUES(?,?,?,?,?,?)').run(matchId, wallet, agentId, stake, enteredAt, canonical ? 1 : 0);
    } else if (canonical && !row.canonical) {
      if (Math.floor(Number(row.entered_at) / 86_400_000) !== Math.floor(enteredAt / 86_400_000)) {
        this.use(agentId, 'paid', Number(row.entered_at), -stake, -1); this.use(agentId, 'paid', enteredAt, stake);
      }
      this.db.prepare('UPDATE entry_accounting SET entered_at=?,canonical=1 WHERE match_id=? AND wallet=?').run(enteredAt, matchId, wallet);
    }
  }
  releaseLease(name: string, holder: string) { this.db.prepare('DELETE FROM leases WHERE name=? AND holder=?').run(name, holder); }
  enqueue(key: string, kind: string, payload: unknown, now: number) {
    const previous = this.db.prepare('SELECT payload FROM jobs WHERE key=?').get(key);
    if (previous) { requireThat(digest(JSON.parse(String(previous.payload))) === digest(payload), 'JOB_CONFLICT', 'A durable operation cannot change its payload.'); return; }
    this.db.prepare('INSERT INTO jobs(key,kind,payload,created_at,updated_at) VALUES(?,?,?,?,?)').run(key, kind, JSON.stringify(payload), now, now);
  }
  audit(event: string, subject: string, details: unknown, now: number) { this.db.prepare('INSERT INTO audit(event,subject,details,at) VALUES(?,?,?,?)').run(event, subject, JSON.stringify(details), now); }
  service(name: string, now: number, error?: string) {
    this.db.prepare('INSERT INTO service_status VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET last_success=CASE WHEN excluded.error IS NULL THEN excluded.last_success ELSE last_success END,failures=CASE WHEN excluded.error IS NULL THEN 0 ELSE failures+1 END,error=excluded.error').run(name, error ? null : now, error ? 1 : 0, error ?? null);
  }
  close(): void { this.db.close(); }
}
