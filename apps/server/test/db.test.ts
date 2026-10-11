import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { migrate, openDb } from '../src/db/connection.ts';
import { all, get, run } from '../src/db/sql.ts';
import { setup } from './helpers.ts';

describe('database', () => {
  it('applies migrations and records the version', () => {
    const db = openDb(':memory:');
    expect(get<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version).toBe(13);
  });

  it('enforces foreign keys with cascade', () => {
    const db = openDb(':memory:');
    const profile = run(db, "INSERT INTO profiles (name) VALUES ('a')").lastInsertId;
    const title = run(db, "INSERT INTO titles (kind, title) VALUES ('movie', 'x')").lastInsertId;
    run(db, 'INSERT INTO my_list (profile_id, title_id) VALUES (?, ?)', profile, title);
    run(db, 'DELETE FROM titles WHERE id = ?', title);
    expect(all(db, 'SELECT * FROM my_list')).toHaveLength(0);
    expect(() => run(db, 'INSERT INTO my_list (profile_id, title_id) VALUES (?, 999)', profile)).toThrow();
  });

  it('keeps media_files rows, ids and children when migrating from v3', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const dir = join(import.meta.dirname, '../src/db/migrations');
    for (const f of ['001_init.sql', '002_ingest.sql', '003_job_priority.sql']) db.exec(readFileSync(join(dir, f), 'utf8'));
    db.exec('PRAGMA user_version = 3');
    const profile = run(db, "INSERT INTO profiles (name) VALUES ('a')").lastInsertId;
    const title = run(db, "INSERT INTO titles (kind, title) VALUES ('movie', 'x')").lastInsertId;
    const file = run(db, "INSERT INTO media_files (path, title_id, status, duration_s, parsed_number) VALUES ('films/x.mkv', ?, 'ready', 10, 4)", title).lastInsertId;
    run(db, 'INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, updated_at) VALUES (?, ?, 1, 10, \'t\')', profile, file);
    run(db, "INSERT INTO jobs (type, media_file_id) VALUES ('process', ?)", file);

    migrate(db);

    expect(get(db, 'PRAGMA user_version')).toMatchObject({ user_version: 13 });
    expect(get(db, 'SELECT id, path, status, parsed_number FROM media_files')).toMatchObject({ id: file, path: 'films/x.mkv', status: 'ready', parsed_number: 4 });
    expect(all(db, 'SELECT * FROM watch_progress')).toHaveLength(1);
    expect(all(db, 'SELECT * FROM jobs')).toHaveLength(1);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(get(db, 'PRAGMA foreign_keys')).toMatchObject({ foreign_keys: 1 });
    expect(get<any>(db, "SELECT sql FROM sqlite_master WHERE name = 'jobs'")?.sql).toContain('REFERENCES media_files(id)');
    run(db, "INSERT INTO media_files (path, title_id, status) VALUES ('films/y.mkv', ?, 'downloading')", title);
    run(db, 'DELETE FROM media_files WHERE id = ?', file);
    expect(all(db, 'SELECT * FROM watch_progress')).toHaveLength(0);
  });

  it('matches FTS prefixes ignoring accents', () => {
    const db = openDb(':memory:');
    run(db, "INSERT INTO search_index (ref_type, ref_id, label) VALUES ('title', 1, 'Más allá del final')");
    expect(all(db, "SELECT label FROM search_index WHERE search_index MATCH '\"mas\"*'")).toHaveLength(1);
  });
});

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const { app } = setup();
    const res = await app.inject('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
