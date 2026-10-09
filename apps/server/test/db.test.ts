import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.ts';
import { all, get, run } from '../src/db/sql.ts';
import { setup } from './helpers.ts';

describe('database', () => {
  it('applies migrations and records the version', () => {
    const db = openDb(':memory:');
    expect(get<{ user_version: number }>(db, 'PRAGMA user_version')?.user_version).toBe(3);
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
