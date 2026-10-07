import { NeonPersistence, type WriterStartupOptions } from '../persistence.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { digest, requireThat } from '../domain.js';
import type { SigningContext, UnsignedTransaction } from './signer.js';

export class SignerKeystore {
  readonly db: DatabaseSync;
  persistence?: NeonPersistence;
  static async open(path: string, encryptionKey: Buffer, url?: string, namespace = 'signer:testnet', startup?: WriterStartupOptions) {
    if (!url) return new SignerKeystore(path, encryptionKey);
    const persistence = await NeonPersistence.open(url, namespace, startup);
    let keys: SignerKeystore | undefined;
    try { keys = new SignerKeystore(persistence.path, encryptionKey); await persistence.attach(keys.db); keys.persistence = persistence; return keys; }
    catch (error) { keys?.db.close(); await persistence.close(); persistence.cleanup(); throw error; }
  }
  async flush() { await this.persistence?.flush(); }
  async shutdown() { await this.persistence?.close(); this.close(); this.persistence?.cleanup(); }

  constructor(path: string, private readonly encryptionKey: Buffer) {
    requireThat(encryptionKey.length === 32, 'SIGNER_ENCRYPTION_KEY', 'Signer storage requires its own 32-byte encryption key.', 503);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS keys(scope TEXT PRIMARY KEY,address TEXT NOT NULL,nonce TEXT NOT NULL,tag TEXT NOT NULL,ciphertext TEXT NOT NULL); CREATE TABLE IF NOT EXISTS signatures(operation TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,scope TEXT NOT NULL,sender TEXT NOT NULL,nonce INTEGER NOT NULL,day INTEGER NOT NULL,fee TEXT NOT NULL,raw TEXT); CREATE UNIQUE INDEX IF NOT EXISTS signer_nonce ON signatures(sender,nonce); CREATE TABLE IF NOT EXISTS gas_topups(operation TEXT PRIMARY KEY, scope TEXT NOT NULL, recipient TEXT NOT NULL, day INTEGER NOT NULL, amount TEXT NOT NULL, nonce INTEGER NOT NULL UNIQUE, hash TEXT NOT NULL, raw TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0);");
  }
  account(scope: string) {
    requireThat(/^(resolver|keeper|gas|agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(scope), 'SIGNER_SCOPE', 'Unknown signer scope.', 400);
    let row = this.db.prepare('SELECT * FROM keys WHERE scope=?').get(scope);
    if (!row) {
      const secret = generatePrivateKey(), account = privateKeyToAccount(secret), nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce); cipher.setAAD(Buffer.from(scope));
      const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
      this.db.prepare('INSERT OR IGNORE INTO keys VALUES(?,?,?,?,?)').run(scope, account.address.toLowerCase(), nonce.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64'));
      row = this.db.prepare('SELECT * FROM keys WHERE scope=?').get(scope)!;
    }
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(String(row.nonce), 'base64'));
    decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(Buffer.from(String(row.tag), 'base64'));
    const secret = Buffer.concat([decipher.update(Buffer.from(String(row.ciphertext), 'base64')), decipher.final()]).toString('utf8') as `0x${string}`;
    const account = privateKeyToAccount(secret);
    requireThat(account.address.toLowerCase() === row.address, 'SIGNER_STORAGE', 'Encrypted key does not match its registered address.', 503);
    return account;
  }
  cached(operation: string, scope: string, tx: UnsignedTransaction, context: SigningContext) {
    const row = this.db.prepare('SELECT fingerprint,raw FROM signatures WHERE operation=?').get(operation);
    if (!row) return;
    requireThat(row.fingerprint === digest({ scope, tx, context }), 'SIGNER_OPERATION_CHANGED', 'Operation IDs cannot be reused with different signing inputs.', 409);
    return row.raw ? String(row.raw) as `0x${string}` : undefined;
  }
  reserve(operation: string, scope: string, tx: UnsignedTransaction, context: SigningContext, sender: string, day: number, ceiling: bigint) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT fingerprint FROM signatures WHERE operation=?').get(operation);
      const fingerprint = digest({ scope, tx, context });
      if (existing) requireThat(existing.fingerprint === fingerprint, 'SIGNER_OPERATION_CHANGED', 'Signing inputs changed.', 409);
      else {
        const used = this.db.prepare('SELECT fee FROM signatures WHERE sender=? AND day=?').all(sender, day).reduce((sum, row) => sum + BigInt(String(row.fee)), 0n);
        const fee = BigInt(tx.gas) * BigInt(tx.maxFeePerGas);
        requireThat(used + fee <= ceiling, 'SIGNER_FEE_BUDGET', 'Service signing-key daily fee reservation exhausted.', 409);
        requireThat(!this.db.prepare('SELECT 1 FROM signatures WHERE sender=? AND nonce=?').get(sender, tx.nonce), 'SIGNER_NONCE_CONFLICT', 'Nonce already belongs to a different signing operation.', 409);
        this.db.prepare('INSERT INTO signatures VALUES(?,?,?,?,?,?,?,NULL)').run(operation, fingerprint, scope, sender, tx.nonce, day, String(fee));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  commit(operation: string, raw: `0x${string}`) { this.db.prepare('UPDATE signatures SET raw=? WHERE operation=? AND raw IS NULL').run(raw, operation); return String(this.db.prepare('SELECT raw FROM signatures WHERE operation=?').get(operation)!.raw) as `0x${string}`; }
  close() { this.db.close(); }
}
