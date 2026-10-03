import { resolve } from 'node:path';
import { backupKey, encryptedBackup, restoreBackup } from '../src/backup.js';
import { DatabaseSync } from 'node:sqlite';

const [operation = 'create', source, destination] = process.argv.slice(2);
if (process.env.DATABASE_URL || process.env.SIGNER_DATABASE_URL) throw new Error('SQLite backup commands do not back up Neon. Use a database snapshot/export and preserve the signer encryption key; see docs/koyeb-deployment.md.');
if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error('Set BACKUP_ENCRYPTION_KEY through your secrets manager; do not paste it into command arguments.');
const key = backupKey(process.env.BACKUP_ENCRYPTION_KEY);
if (operation === 'restore') {
  if (!source || !destination) throw new Error('Usage: backup restore <encrypted-backup> <new-database-path>');
  restoreBackup(resolve(source), resolve(destination), key);
  console.log('Restored and verified the new database. Stop all workers before switching DATABASE_PATH.');
} else if (operation === 'create') {
  const database = new DatabaseSync(process.env.DATABASE_PATH ?? './data/platform.sqlite', { readOnly: true });
  try { await encryptedBackup(database, resolve(source ?? `./data/backups/${Date.now()}.enc`), key); console.log('Encrypted database backup completed.'); }
  finally { database.close(); }
} else throw new Error('Choose create or restore.');
