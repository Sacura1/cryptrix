import { backup, DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requireThat } from './domain.js';
import { DATABASE_VERSION } from './store.js';

const MAGIC = Buffer.from('CRYPTRIX-BACKUP-1\n');
const MAX_BACKUP = 128 * 1024 * 1024;
export function backupKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64'); requireThat(key.length === 32, 'BACKUP_KEY', 'Backup encryption requires a separate 32-byte base64 key.', 400); return key;
}
export async function encryptedBackup(db: DatabaseSync, destination: string, key: Buffer): Promise<void> {
  requireThat(key.length === 32, 'BACKUP_KEY', 'Invalid backup key.', 400);
  const target = resolve(destination), temp = `${target}.${randomBytes(8).toString('hex')}.sqlite-tmp`;
  requireThat(!existsSync(target), 'BACKUP_EXISTS', 'Refusing to replace an existing backup.', 409);
  mkdirSync(dirname(target), { recursive: true });
  try {
    await backup(db, temp);
    requireThat(statSync(temp).size <= MAX_BACKUP, 'BACKUP_SIZE', 'Use a streaming backup service above 128 MiB.', 503);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([cipher.update(readFileSync(temp)), cipher.final()]);
    writeFileSync(target, Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]), { flag: 'wx', mode: 0o600 });
  } finally { if (existsSync(temp)) rmSync(temp); }
}
export function restoreBackup(source: string, destination: string, key: Buffer): void {
  const target = resolve(destination);
  requireThat(!existsSync(target), 'RESTORE_EXISTS', 'Restore to a new database path; never overwrite a running database.', 409);
  requireThat(statSync(source).size <= MAX_BACKUP + 1024, 'BACKUP_SIZE', 'Backup exceeds the local restore limit.', 400);
  const bytes = readFileSync(source);
  requireThat(bytes.subarray(0, MAGIC.length).equals(MAGIC), 'BACKUP_FORMAT', 'Unknown backup format.', 400);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
  decipher.setAAD(MAGIC); decipher.setAuthTag(bytes.subarray(MAGIC.length + 12, MAGIC.length + 28));
  const data = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 28)), decipher.final()]);
  mkdirSync(dirname(target), { recursive: true });
  // Authentication succeeds before any plaintext is written.
  writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
  let check: DatabaseSync | undefined;
  try {
    check = new DatabaseSync(target, { readOnly: true });
    requireThat(check.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', 'RESTORE_CORRUPT', 'Restored database failed integrity verification.', 503);
    requireThat(Number(check.prepare('PRAGMA user_version').get()?.user_version) <= DATABASE_VERSION, 'DATABASE_VERSION', 'Backup belongs to a newer backend.', 503);
  } catch (error) { check?.close(); check = undefined; rmSync(target); throw error; }
  finally { check?.close(); }
}
