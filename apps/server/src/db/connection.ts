import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version <= row.user_version) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
