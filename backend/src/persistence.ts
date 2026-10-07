import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { DatabaseSync, Session } from 'node:sqlite';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

export interface WriterStartupOptions {
  waitMs?: number;
  retryMs?: number;
  signal?: AbortSignal;
  onWait?: () => void;
}

/** A single authoritative simulation process, with asynchronous PostgreSQL durability.
 * SQLite is a disposable local state engine. Postgres holds checkpoints and a fenced
 * changeset journal. Never acknowledge a mutation or broadcast before flush().
 * One active writer per namespace; other instances fail closed rather than diverge.
 */
export class NeonPersistence {
  readonly directory = mkdtempSync(join(tmpdir(), 'cryptrix-state-'));
  readonly path = join(this.directory, 'state.sqlite');
  private readonly owner = randomUUID();
  private readonly pool: pg.Pool;
  private session?: Session;
  private db?: DatabaseSync;
  private queue: Promise<void> = Promise.resolve();
  private flushing = false;
  private nextFlush?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private fault?: Error;
  private checkpointAt = Date.now();
  private closing = false;
  private constructor(url: string, readonly namespace: string) {
    if (!/^(postgres|postgresql):/.test(url) || !/^[a-zA-Z0-9:_-]{1,100}$/.test(namespace)) throw new Error('Invalid persistent storage configuration');
    this.pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15000, idleTimeoutMillis: 20000, statement_timeout: 15000 });
    // Checked-out clients emit errors themselves; the pool listener only covers idle clients.
    this.pool.on('connect', client => client.on('error', () => { this.fault = new Error('NEON_CONNECTION_LOST'); }));
    this.pool.on('error', () => { this.fault = new Error('NEON_CONNECTION_LOST'); });
  }
  static async open(url: string, namespace: string, options: WriterStartupOptions = {}): Promise<NeonPersistence> {
    const waitMs = options.waitMs ?? 0, retryMs = options.retryMs ?? 2000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || !Number.isSafeInteger(retryMs) || retryMs < 1) throw new Error('Invalid database startup wait');
    const p = new NeonPersistence(url, namespace);
    let phase: 'database' | 'snapshot' = 'database';
    let leaseAttempted = false;
    try {
      if (options.signal?.aborted) throw new Error('NEON_STARTUP_CANCELLED');
      await p.pool.query(`CREATE TABLE IF NOT EXISTS cryptrix_state (
        namespace TEXT PRIMARY KEY, owner TEXT, lease_until TIMESTAMPTZ,
        seq BIGINT NOT NULL DEFAULT 0, checkpoint_seq BIGINT NOT NULL DEFAULT 0,
        snapshot BYTEA
      ); CREATE TABLE IF NOT EXISTS cryptrix_journal (
        namespace TEXT NOT NULL REFERENCES cryptrix_state(namespace), seq BIGINT NOT NULL,
        payload BYTEA NOT NULL, PRIMARY KEY(namespace,seq)
      );`);
      await p.pool.query('INSERT INTO cryptrix_state(namespace) VALUES($1) ON CONFLICT DO NOTHING', [namespace]);
      const deadline = Date.now() + waitMs;
      let waiting = false;
      for (;;) {
        if (options.signal?.aborted) throw new Error('NEON_STARTUP_CANCELLED');
        leaseAttempted = true;
        const result = await p.pool.query(`UPDATE cryptrix_state SET owner=$2,lease_until=NOW()+INTERVAL '120 seconds'
          WHERE namespace=$1 AND (owner IS NULL OR lease_until<NOW()) RETURNING snapshot`, [namespace, p.owner]);
        if (options.signal?.aborted) throw new Error('NEON_STARTUP_CANCELLED');
        if (result.rowCount) {
          phase = 'snapshot';
          if (result.rows[0].snapshot) writeFileSync(p.path, inflateSync(result.rows[0].snapshot));
          return p;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('NEON_WRITER_ALREADY_RUNNING');
        if (!waiting) { waiting = true; options.onWait?.(); }
        try { await delay(Math.min(retryMs, remaining), undefined, { signal: options.signal }); }
        catch (error) { if (options.signal?.aborted) throw new Error('NEON_STARTUP_CANCELLED'); throw error; }
      }
    } catch (error) {
      // Also handles cancellation or a broken snapshot after acquiring the lease.
      // The owner condition can never release a different process's writer lock.
      if (leaseAttempted) await p.pool.query('UPDATE cryptrix_state SET owner=NULL,lease_until=NULL WHERE namespace=$1 AND owner=$2', [namespace, p.owner]).catch(() => {});
      await p.pool.end().catch(() => {}); rmSync(p.directory, { recursive: true, force: true });
      if (error instanceof Error && error.message === 'NEON_STARTUP_CANCELLED') throw error;
      if (error instanceof Error && error.message === 'NEON_WRITER_ALREADY_RUNNING') {
        throw new Error('NEON_STARTUP_FAILED: NEON_WRITER_ALREADY_RUNNING. Startup wait expired. Use stop-before-start deployment and one instance per namespace.');
      }
      // Driver messages can contain connection details; expose only a bounded error code.
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{2,48}$/.test(error.code) ? error.code : 'UNKNOWN';
      const cause = phase === 'snapshot' ? 'NEON_SNAPSHOT_RESTORE_FAILED' : 'NEON_DATABASE_STARTUP_FAILED';
      throw new Error(`NEON_STARTUP_FAILED: ${cause} (${code}). ${phase === 'snapshot' ? 'Check the existing database snapshot; preserve the deployed state.' : 'Check DATABASE_URL, database access and network connectivity.'}`);
    }
  }
  async attach(db: DatabaseSync): Promise<void> {
    this.db = db;
    try {
      const result = await this.pool.query(`SELECT payload FROM cryptrix_journal
        WHERE namespace=$1 AND seq>(SELECT checkpoint_seq FROM cryptrix_state WHERE namespace=$1) ORDER BY seq`, [this.namespace]);
      for (const row of result.rows) if (!db.applyChangeset(inflateSync(row.payload))) throw new Error('NEON_RESTORE_CONFLICT');
      this.session = db.createSession();
      this.heartbeat = setInterval(() => {
        if (this.fault || this.closing) return;
        void this.pool.query(`UPDATE cryptrix_state SET lease_until=NOW()+INTERVAL '120 seconds'
          WHERE namespace=$1 AND owner=$2 AND lease_until>NOW()`, [this.namespace, this.owner])
          .then(r => { if (!r.rowCount) this.fault = new Error('NEON_WRITER_LEASE_LOST'); })
          .catch(() => { this.fault = new Error('NEON_WRITER_LEASE_LOST'); });
      }, 20000);
      this.heartbeat.unref();
    } catch { await this.close(); throw new Error('NEON_RESTORE_FAILED'); }
  }
  get healthy(): boolean { return !this.fault && !this.closing; }
  async flush(): Promise<void> {
    if (this.fault) throw this.fault;
    if (!this.db || !this.session || this.closing) throw new Error('NEON_STORAGE_CLOSED');
    if (this.db.isTransaction) throw new Error('Flush must follow the local transaction commit');
    // Coalesce callers arriving during a write into one following durability barrier.
    // Each caller still waits for a commit containing all changes made before its call.
    if (this.flushing) {
      if (!this.nextFlush) this.nextFlush = this.queue.then(() => {
        this.nextFlush = undefined;
        return this.flush();
      });
      return this.nextFlush;
    }
    const changes = this.session.changeset();
    this.session.close(); this.session = this.db.createSession();
    if (!changes.length) return this.queue;
    const payload = deflateSync(changes, { level: 3 });
    let snapshot: Buffer | undefined;
    if (Date.now() - this.checkpointAt >= 60000) {
      // Snapshot and captured changes belong to this exact synchronous state boundary.
      const file = join(this.directory, `checkpoint-${randomUUID()}.sqlite`);
      this.db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
      snapshot = deflateSync(readFileSync(file), { level: 3 });
      rmSync(file); this.checkpointAt = Date.now();
    }
    this.flushing = true;
    this.queue = this.queue.then(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE cryptrix_state SET seq=seq+1,lease_until=NOW()+INTERVAL '120 seconds'
          WHERE namespace=$1 AND owner=$2 AND lease_until>NOW() RETURNING seq`, [this.namespace, this.owner]);
        if (!result.rowCount) throw new Error('NEON_WRITER_LEASE_LOST');
        const seq = result.rows[0].seq;
        if (snapshot) {
          await client.query('UPDATE cryptrix_state SET checkpoint_seq=$3,snapshot=$4 WHERE namespace=$1 AND owner=$2', [this.namespace,this.owner,seq,snapshot]);
          await client.query('DELETE FROM cryptrix_journal WHERE namespace=$1 AND seq<=$2', [this.namespace,seq]);
        } else await client.query('INSERT INTO cryptrix_journal(namespace,seq,payload) VALUES($1,$2,$3)', [this.namespace,seq,payload]);
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => {});
        this.fault = new Error('NEON_DURABILITY_FAILED'); throw this.fault;
      } finally { client.release(); }
    }).catch(() => { this.fault = new Error('NEON_DURABILITY_FAILED'); throw this.fault; }).finally(() => { this.flushing = false; });
    return this.queue;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    if (this.session && !this.fault) await this.flush().catch(() => {});
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.session?.close();
    await this.queue.catch(() => {});
    await this.pool.query('UPDATE cryptrix_state SET owner=NULL,lease_until=NULL WHERE namespace=$1 AND owner=$2', [this.namespace,this.owner]).catch(() => {});
    await this.pool.end().catch(() => {});
    // Remove only this process's generated temporary directory, never the local source DB.
  }
  cleanup() { rmSync(this.directory, { recursive: true, force: true }); }
}
