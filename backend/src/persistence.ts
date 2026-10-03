import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { DatabaseSync, Session } from 'node:sqlite';
import pg from 'pg';

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
  private heartbeat?: ReturnType<typeof setInterval>;
  private fault?: Error;
  private checkpointAt = Date.now();
  private closing = false;
  private constructor(url: string, readonly namespace: string) {
    if (!/^(postgres|postgresql):/.test(url) || !/^[a-zA-Z0-9:_-]{1,100}$/.test(namespace)) throw new Error('Invalid persistent storage configuration');
    this.pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15000, idleTimeoutMillis: 20000, statement_timeout: 15000 });
    this.pool.on('error', () => { this.fault = new Error('NEON_CONNECTION_LOST'); });
  }
  static async open(url: string, namespace: string): Promise<NeonPersistence> {
    const p = new NeonPersistence(url, namespace);
    try {
      await p.pool.query(`CREATE TABLE IF NOT EXISTS cryptrix_state (
        namespace TEXT PRIMARY KEY, owner TEXT, lease_until TIMESTAMPTZ,
        seq BIGINT NOT NULL DEFAULT 0, checkpoint_seq BIGINT NOT NULL DEFAULT 0,
        snapshot BYTEA
      ); CREATE TABLE IF NOT EXISTS cryptrix_journal (
        namespace TEXT NOT NULL REFERENCES cryptrix_state(namespace), seq BIGINT NOT NULL,
        payload BYTEA NOT NULL, PRIMARY KEY(namespace,seq)
      );`);
      await p.pool.query('INSERT INTO cryptrix_state(namespace) VALUES($1) ON CONFLICT DO NOTHING', [namespace]);
      const result = await p.pool.query(`UPDATE cryptrix_state SET owner=$2,lease_until=NOW()+INTERVAL '120 seconds'
        WHERE namespace=$1 AND (owner IS NULL OR lease_until<NOW()) RETURNING snapshot`, [namespace, p.owner]);
      if (!result.rowCount) throw new Error('NEON_WRITER_ALREADY_RUNNING');
      if (result.rows[0].snapshot) writeFileSync(p.path, inflateSync(result.rows[0].snapshot));
      return p;
    } catch {
      await p.pool.end(); rmSync(p.directory, { recursive: true, force: true });
      throw new Error('NEON_STARTUP_FAILED: database unavailable or another writer owns this namespace');
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
    }).catch(() => { this.fault = new Error('NEON_DURABILITY_FAILED'); throw this.fault; });
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
