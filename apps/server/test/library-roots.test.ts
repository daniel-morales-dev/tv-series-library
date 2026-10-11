import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { migrate, openDb } from '../src/db/connection.ts';
import { all, get, run } from '../src/db/sql.ts';
import { linkPrimaryRoot, sourcePath } from '../src/library/roots.ts';
import { setSourceDir } from '../src/modules/ingest/metadata.ts';

const dir = join(import.meta.dirname, '../src/db/migrations');
const V10 = ['001_init', '002_ingest', '003_job_priority', '004_downloading_status', '005_seasons_group', '006_job_process', '007_person_name_checked', '008_package_cache', '009_franchises', '010_chapters'];

function dbAtV10(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of V10) db.exec(readFileSync(join(dir, `${f}.sql`), 'utf8'));
  db.exec('PRAGMA user_version = 10');
  return db;
}

describe('011 library_roots migration', () => {
  it('keeps every row, id, child and sequence while attaching them to a placeholder root', () => {
    const db = dbAtV10();
    const profile = run(db, "INSERT INTO profiles (name) VALUES ('a')").lastInsertId;
    const title = run(db, "INSERT INTO titles (kind, title) VALUES ('series', 's')").lastInsertId;
    const a = run(db, "INSERT INTO media_files (path, size, title_id, status, hls_dir, duration_s, pkg_mode, pkg_bytes, last_played_at, chapters_checked, parsed_number) VALUES ('shows/s/1.mkv', 5, ?, 'ready', 'hls/1', 10, 'copy', 7, 't', 1, 1)", title).lastInsertId;
    const b = run(db, "INSERT INTO media_files (path, title_id, status) VALUES ('shows/s/2.mkv', ?, 'pending')", title).lastInsertId;
    const gone = run(db, "INSERT INTO media_files (path, title_id) VALUES ('shows/s/gone.mkv', ?)", title).lastInsertId;
    run(db, 'DELETE FROM media_files WHERE id = ?', gone);
    run(db, "INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, updated_at) VALUES (?, ?, 1, 10, 't')", profile, a);
    run(db, "INSERT INTO jobs (type, media_file_id) VALUES ('process', ?)", b);
    run(db, 'INSERT INTO media_chapters (media_file_id, idx, start_s, end_s) VALUES (?, 0, 0, 1)', a);
    run(db, "INSERT INTO source_dirs (path, title_id, season_number) VALUES ('shows/s', ?, 1)", title);
    run(db, "INSERT INTO pending_files (path, size, parsed, reason) VALUES ('films/p.mkv', 3, '{}', 'unparsed')");

    migrate(db);

    expect(get(db, 'PRAGMA user_version')).toMatchObject({ user_version: 15 });
    expect(get(db, 'SELECT id, library_id, last_known_path, position FROM library_roots')).toEqual({ id: 1, library_id: null, last_known_path: null, position: 0 });
    expect(all(db, 'SELECT id, root_id, path, size, status, hls_dir, pkg_mode, pkg_bytes, last_played_at, chapters_checked, parsed_number FROM media_files ORDER BY id')).toEqual([
      { id: a, root_id: 1, path: 'shows/s/1.mkv', size: 5, status: 'ready', hls_dir: 'hls/1', pkg_mode: 'copy', pkg_bytes: 7, last_played_at: 't', chapters_checked: 1, parsed_number: 1 },
      { id: b, root_id: 1, path: 'shows/s/2.mkv', size: null, status: 'pending', hls_dir: null, pkg_mode: null, pkg_bytes: null, last_played_at: null, chapters_checked: 0, parsed_number: null },
    ]);
    expect(all(db, 'SELECT * FROM watch_progress')).toHaveLength(1);
    expect(all(db, 'SELECT * FROM jobs')).toHaveLength(1);
    expect(all(db, 'SELECT * FROM media_chapters')).toHaveLength(1);
    expect(get(db, 'SELECT root_id, path, title_id, season_number FROM source_dirs')).toEqual({ root_id: 1, path: 'shows/s', title_id: title, season_number: 1 });
    expect(get(db, 'SELECT id, root_id, path, size FROM pending_files')).toMatchObject({ root_id: 1, path: 'films/p.mkv', size: 3 });
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
    // The deleted id is never reused (HLS folders are named by id).
    expect(run(db, "INSERT INTO media_files (path, title_id) VALUES ('shows/s/3.mkv', ?)", title).lastInsertId).toBeGreaterThan(gone);
    // Children still cascade from the rebuilt table.
    run(db, 'DELETE FROM media_files WHERE id = ?', a);
    expect(all(db, 'SELECT * FROM watch_progress')).toHaveLength(0);
    expect(get<any>(db, "SELECT sql FROM sqlite_master WHERE name = 'jobs'")?.sql).toContain('REFERENCES media_files(id)');
  });

  it('migrates an empty database and applies the unique key per root', () => {
    const db = openDb(':memory:');
    expect(all(db, 'SELECT id FROM library_roots')).toEqual([{ id: 1 }]);
    const title = run(db, "INSERT INTO titles (kind, title) VALUES ('movie', 'x')").lastInsertId;
    run(db, "INSERT INTO library_roots (library_id, label, position) VALUES ('other', 'HDD', 1)");
    run(db, "INSERT INTO media_files (path, title_id) VALUES ('films/x.mkv', ?)", title);
    expect(() => run(db, "INSERT INTO media_files (path, title_id) VALUES ('films/x.mkv', ?)", title)).toThrow(/UNIQUE/);
    run(db, "INSERT INTO media_files (root_id, path, title_id) VALUES (2, 'films/x.mkv', ?)", title);
    expect(() => run(db, "INSERT INTO media_files (root_id, path, title_id) VALUES (99, 'films/z.mkv', ?)", title)).toThrow(/FOREIGN KEY/);
    run(db, "INSERT OR IGNORE INTO pending_files (path, parsed, reason) VALUES ('films/q.mkv', '{}', 'unparsed')");
    run(db, "INSERT OR IGNORE INTO pending_files (path, parsed, reason) VALUES ('films/q.mkv', '{}', 'unparsed')");
    expect(all(db, 'SELECT * FROM pending_files')).toHaveLength(1);
  });

  it('keeps setSourceDir idempotent', () => {
    const db = openDb(':memory:');
    const t1 = run(db, "INSERT INTO titles (kind, title) VALUES ('series', 'a')").lastInsertId;
    const t2 = run(db, "INSERT INTO titles (kind, title) VALUES ('series', 'b')").lastInsertId;
    setSourceDir(db, 'shows/a', t1, null);
    setSourceDir(db, 'shows/a', t2, 2);
    expect(all(db, 'SELECT path, title_id, season_number FROM source_dirs')).toEqual([{ path: 'shows/a', title_id: t2, season_number: 2 }]);
  });
});

describe('sourcePath', () => {
  it('joins the single content folder, given as a string or a getter, with the relative path', () => {
    expect(sourcePath('/c', 1, 'shows/a.mkv')).toBe('/c/shows/a.mkv');
    let current = '/c';
    const live = () => current;
    expect(sourcePath(live, 1, 'films/a.mkv')).toBe('/c/films/a.mkv');
    current = '/d';
    expect(sourcePath(live, 1, 'films/a.mkv')).toBe('/d/films/a.mkv');
  });

  it('asks a per-root getter for the folder of that root and defaults to root 1', () => {
    const roots = (id: number) => (id === 2 ? '/hdd' : '/pc');
    expect(sourcePath(roots, 2, 'shows/a.mkv')).toBe('/hdd/shows/a.mkv');
    expect(sourcePath(roots, undefined, 'shows/a.mkv')).toBe('/pc/shows/a.mkv');
  });
});

describe('linkPrimaryRoot', () => {
  it('links the placeholder root to the configured library once and refreshes its last known path', () => {
    const db = openDb(':memory:');
    linkPrimaryRoot(db, { libraryId: 'lib-1', path: '/mnt/a/content' });
    expect(get(db, 'SELECT library_id, last_known_path, label FROM library_roots WHERE id = 1')).toEqual({ library_id: 'lib-1', last_known_path: '/mnt/a/content', label: 'content' });
    linkPrimaryRoot(db, { libraryId: 'lib-1', path: '/mnt/b/content' });
    expect(get(db, 'SELECT last_known_path FROM library_roots WHERE id = 1')).toEqual({ last_known_path: '/mnt/b/content' });
    linkPrimaryRoot(db, { libraryId: 'lib-2', path: '/mnt/z' });
    expect(all(db, 'SELECT library_id FROM library_roots')).toEqual([{ library_id: 'lib-1' }]);
  });
});
