import { mkdir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRecoveryRecord, serializeRecoveryRecord, type RecoveryRecord, type TransactionRecoveryStore } from '@daoships/sdk';
import { CliError, json } from './values.js';

/** SQLite owns cross-process exclusion and releases it on process death. No stale PID locks. */
export class Store implements TransactionRecoveryStore {
  private constructor(readonly directory: string, private db: DatabaseSync) {}
  static async open(directory: string): Promise<Store> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (!dir.isDirectory() || (process.platform !== 'win32' && ((dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())))) throw new CliError('CONFIG', 'Use an owner-only configuration directory (chmod 700), without symlinks.');
    const file = join(directory, 'state.sqlite');
    const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) throw new CliError('CONFIG', 'The state database must be an owner-only regular file (chmod 600), without links.');
    } finally { await handle.close(); }
    const db = new DatabaseSync(file);
    try { db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, data TEXT NOT NULL);'); }
    catch (error) { db.close(); throw error; }
    return new Store(directory, db);
  }
  async read(key: string): Promise<RecoveryRecord | null> {
    const row = this.db.prepare('SELECT data FROM records WHERE key=?').get(key);
    return row ? parseRecoveryRecord(row.data as string) : null;
  }
  async compareAndSwap(key: string, expected: number | null, next: RecoveryRecord): Promise<boolean> {
    const data = serializeRecoveryRecord(next), normalized = parseRecoveryRecord(data);
    if (normalized.revision !== (expected === null ? 0 : expected + 1)) throw new CliError('PERSISTENCE_ERROR', 'Invalid recovery revision.', {}, 3);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT data FROM records WHERE key=?').get(key);
      const previous = row ? parseRecoveryRecord(row.data as string) : null;
      if ((previous?.revision ?? null) !== expected) { this.db.exec('ROLLBACK'); return false; }
      if (previous && (previous.id !== normalized.id || previous.kind !== normalized.kind
        || (previous.kind === 'transaction' && normalized.kind === 'transaction' && json(previous.intent) !== json(normalized.intent))
        || (previous.kind === 'nonce' && normalized.kind === 'nonce' && (previous.chainId !== normalized.chainId || previous.from !== normalized.from)))) {
        throw new CliError('PERSISTENCE_ERROR', 'Recovery identity and intent are immutable.', {}, 3);
      }
      this.db.prepare('INSERT INTO records(key,revision,data) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(key, normalized.revision, data);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  records(limit = 100, offset = 0): RecoveryRecord[] {
    return this.db.prepare('SELECT data FROM records ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => parseRecoveryRecord(row.data as string));
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT data FROM documents WHERE key=?').get(key);
    return row ? JSON.parse(row.data as string) as T : null;
  }
  put(key: string, value: unknown): void {
    const data = json(value);
    if (Buffer.byteLength(data) > 2_200_000) throw new CliError('USAGE', 'Stored document exceeds the size limit.');
    this.db.prepare('INSERT INTO documents(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, data);
  }
  insert(key: string, value: unknown): boolean {
    const data = json(value);
    if (Buffer.byteLength(data) > 2_200_000) throw new CliError('USAGE', 'Stored document exceeds the size limit.');
    return this.db.prepare('INSERT OR IGNORE INTO documents(key,data) VALUES(?,?)').run(key, data).changes === 1;
  }
  swapDocument(key: string, previous: unknown, next: unknown): boolean {
    const data = json(next);
    if (Buffer.byteLength(data) > 2_200_000) throw new CliError('USAGE', 'Stored document exceeds the size limit.');
    return this.db.prepare('UPDATE documents SET data=? WHERE key=? AND data=?').run(data, key, json(previous)).changes === 1;
  }
  /** Atomically bind encrypted key material and public configuration, with cross-process CAS. */
  changeDocuments(changes: { key: string; previous: unknown; next: unknown }[]): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const change of changes) {
        if (json(this.get(change.key)) !== json(change.previous)) { this.db.exec('ROLLBACK'); return false; }
      }
      for (const { key, next } of changes) {
        if (next === null) this.db.prepare('DELETE FROM documents WHERE key=?').run(key);
        else this.put(key, next);
      }
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  documents<T>(prefix: string, limit = 100, offset = 0): T[] {
    return this.db.prepare('SELECT data FROM documents WHERE substr(key,1,?)=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(prefix.length, prefix, limit, offset).map(row => JSON.parse(row.data as string) as T);
  }
  close(): void { this.db.close(); }
}
