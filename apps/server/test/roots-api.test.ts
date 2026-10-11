import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { readMarker, writeMarker } from '../src/config/config.ts';
import { openDb } from '../src/db/connection.ts';
import { all, get, run } from '../src/db/sql.ts';
import { linkPrimaryRoot } from '../src/library/roots.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import { setSourceDir } from '../src/modules/ingest/metadata.ts';
import type { Probe } from '../src/modules/ingest/probe.ts';
import { addTitle } from './helpers.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix = 'tvlib-roots-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Root 1 (marked primary) plus one marked HDD root; `mounts` is what the suggestion scan is injected with. */
function env() {
  const base = tmp();
  const primary = join(base, 'content');
  const hdd = join(base, 'hdd');
  const mounts = join(base, 'mounts');
  for (const dir of [primary, hdd, mounts]) mkdirSync(dir, { recursive: true });
  writeMarker(primary, 'lib-1');
  writeMarker(hdd, 'hdd-1');
  const db = openDb(':memory:');
  linkPrimaryRoot(db, { libraryId: 'lib-1', path: primary });
  const hddId = run(db, 'INSERT INTO library_roots (library_id, last_known_path, label, position) VALUES (?, ?, ?, 1)', 'hdd-1', hdd, 'HDD').lastInsertId;
  const app = buildApp({ db, roots: { contentDir: () => primary, mountRoots: () => [mounts] } });
  return { db, app, primary, hdd, mounts, hddId };
}

let seq = 0;
function addMediaFile(db: DatabaseSync, rootId: number, rel: string) {
  const titleId = run(db, "INSERT INTO titles (kind, title) VALUES ('movie', ?)", `t${++seq}`).lastInsertId;
  return run(db, "INSERT INTO media_files (root_id, path, title_id, status) VALUES (?, ?, ?, 'ready')", rootId, rel, titleId).lastInsertId;
}

const listRoots = async (app: ReturnType<typeof env>['app']) => (await app.inject('/api/roots')).json().roots as Record<string, unknown>[];

describe('GET /api/roots', () => {
  it('lists the primary root present and an absent root with its moved candidate', async () => {
    const e = env();
    addMediaFile(e.db, e.hddId, 'shows/a/1.mkv');
    addMediaFile(e.db, e.hddId, 'shows/a/2.mkv');
    const moved = join(e.mounts, 'HDD2');
    mkdirSync(moved);
    writeMarker(moved, 'hdd-1');
    rmSync(e.hdd, { recursive: true, force: true });

    const res = await e.app.inject('/api/roots');
    expect(res.statusCode).toBe(200);
    const roots = res.json().roots;
    expect(roots).toHaveLength(2);
    expect(roots[0]).toMatchObject({ id: 1, label: 'content', path: e.primary, lastKnownPath: e.primary, present: true, sameLibrary: true, files: 0, suggestion: null });
    expect(roots[1]).toMatchObject({ id: e.hddId, label: 'HDD', path: e.hdd, lastKnownPath: e.hdd, present: false, sameLibrary: false, files: 2, suggestion: moved });
  });
});

describe('POST /api/roots', () => {
  it('creates a root for a new folder: 201, marker written, position appended', async () => {
    const e = env();
    const fresh = join(tmp(), 'disco nuevo');
    mkdirSync(fresh);

    const res = await e.app.inject({ method: 'POST', url: '/api/roots', payload: { path: fresh } });
    expect(res.statusCode).toBe(201);
    const root = res.json().root;
    expect(root).toMatchObject({ label: basename(fresh), path: fresh, lastKnownPath: fresh, present: true, sameLibrary: true, files: 0, suggestion: null });
    const row = get<{ library_id: string; position: number }>(e.db, 'SELECT library_id, position FROM library_roots WHERE id = ?', root.id)!;
    expect(row.position).toBe(2);
    expect(readMarker(fresh)).toEqual({ libraryId: row.library_id });
  });

  it('answers 200 and refreshes the marker when the same folder is added again', async () => {
    const e = env();
    const fresh = join(tmp(), 'disco');
    mkdirSync(fresh);
    const first = await e.app.inject({ method: 'POST', url: '/api/roots', payload: { path: fresh } });
    expect(first.statusCode).toBe(201);

    rmSync(join(fresh, '.sala-library.json'));
    const again = await e.app.inject({ method: 'POST', url: '/api/roots', payload: { path: fresh } });
    expect(again.statusCode).toBe(200);
    expect(again.json().root.id).toBe(first.json().root.id);
    const row = get<{ library_id: string }>(e.db, 'SELECT library_id FROM library_roots WHERE id = ?', first.json().root.id)!;
    expect(readMarker(fresh)).toEqual({ libraryId: row.library_id });
  });

  it('re-links an absent root when its marker reappears at another path', async () => {
    const e = env();
    rmSync(e.hdd, { recursive: true, force: true });
    const moved = join(e.mounts, 'HDD');
    mkdirSync(moved);
    writeMarker(moved, 'hdd-1');

    const res = await e.app.inject({ method: 'POST', url: '/api/roots', payload: { path: moved } });
    expect(res.statusCode).toBe(200);
    expect(res.json().root).toMatchObject({ id: e.hddId, label: 'HDD', path: moved, lastKnownPath: moved, present: true });
    expect(get(e.db, 'SELECT last_known_path FROM library_roots WHERE id = ?', e.hddId)).toEqual({ last_known_path: moved });
  });

  it('rejects a folder marked by another library with 409 and creates nothing', async () => {
    const e = env();
    const foreign = join(tmp(), 'otra');
    mkdirSync(foreign);
    writeMarker(foreign, 'otra-lib');

    const res = await e.app.inject({ method: 'POST', url: '/api/roots', payload: { path: foreign } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'other_library' });
    expect(res.json().message).toBeTruthy();
    expect(get<{ n: number }>(e.db, 'SELECT COUNT(*) AS n FROM library_roots')!.n).toBe(2);
  });

  it('rejects a path that is not a readable directory', async () => {
    const e = env();
    const file = join(tmp(), 'nota.txt');
    writeFileSync(file, 'x');
    const res = await e.app.inject({ method: 'POST', url: '/api/roots', payload: { path: file } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_path' });
  });
});

describe('POST /api/roots/:id/relocate', () => {
  it('points the root at the folder carrying its marker and updates the last known path', async () => {
    const e = env();
    const moved = join(e.mounts, 'HDD');
    mkdirSync(moved);
    writeMarker(moved, 'hdd-1');

    const res = await e.app.inject({ method: 'POST', url: `/api/roots/${e.hddId}/relocate`, payload: { path: moved } });
    expect(res.statusCode).toBe(200);
    expect(res.json().root).toMatchObject({ id: e.hddId, label: 'HDD', path: moved, lastKnownPath: moved, present: true, sameLibrary: true });
  });

  it('rejects a folder marked by another library and one with no marker at all', async () => {
    const e = env();
    const foreign = join(tmp(), 'otra');
    mkdirSync(foreign);
    writeMarker(foreign, 'otra-lib');
    const other = await e.app.inject({ method: 'POST', url: `/api/roots/${e.hddId}/relocate`, payload: { path: foreign } });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: 'other_library' });

    const empty = join(tmp(), 'vacia');
    mkdirSync(empty);
    const notMoved = await e.app.inject({ method: 'POST', url: `/api/roots/${e.hddId}/relocate`, payload: { path: empty } });
    expect(notMoved.statusCode).toBe(409);
    expect(notMoved.json()).toMatchObject({ error: 'not_moved' });
    expect(get(e.db, 'SELECT last_known_path FROM library_roots WHERE id = ?', e.hddId)).toEqual({ last_known_path: e.hdd });
  });

  it('answers 404 for an unknown root', async () => {
    const e = env();
    const res = await e.app.inject({ method: 'POST', url: '/api/roots/999/relocate', payload: { path: e.hdd } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('DELETE /api/roots/:id', () => {
  it('forgets a root without touching its media rows and never forgets the primary one', async () => {
    const e = env();
    addMediaFile(e.db, e.hddId, 'shows/a/1.mkv');

    const del = await e.app.inject({ method: 'DELETE', url: `/api/roots/${e.hddId}` });
    expect(del.statusCode).toBe(204);
    expect((await listRoots(e.app)).map((r) => r.id)).toEqual([1]);
    expect(get<{ n: number }>(e.db, 'SELECT COUNT(*) AS n FROM media_files WHERE root_id = ?', e.hddId)!.n).toBe(1);

    const primary = await e.app.inject({ method: 'DELETE', url: '/api/roots/1' });
    expect(primary.statusCode).toBe(400);
    expect(primary.json()).toMatchObject({ error: 'primary_root' });
    expect(primary.json().message).toBeTruthy();

    const missing = await e.app.inject({ method: 'DELETE', url: '/api/roots/999' });
    expect(missing.statusCode).toBe(404);
  });
});

const NOW = Date.parse('2026-01-01T12:00:00Z');

describe('ingestor with forgotten roots', () => {
  it('skips a forgotten root when scanning', async () => {
    const e = env();
    const titleId = addTitle(e.db, 'Show A', { kind: 'series' });
    run(e.db, "UPDATE titles SET metadata_status = 'ready' WHERE id = ?", titleId);
    setSourceDir(e.db, 'shows/Show A', titleId, 1);
    setSourceDir(e.db, 'shows/Show B', titleId, 1, e.hddId);
    const addVideo = (base: string, rel: string) => {
      const abs = join(base, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, 'x');
      utimesSync(abs, (NOW - 3600_000) / 1000, (NOW - 3600_000) / 1000);
    };
    addVideo(e.primary, 'shows/Show A/Show A S01E01.mkv');
    addVideo(e.hdd, 'shows/Show B/Show B S01E01.mkv');

    await e.app.inject({ method: 'DELETE', url: `/api/roots/${e.hddId}` });
    const probe: Probe = async () => ({ durationS: 100, audio: [], subtitles: [] });
    const ingestor = createIngestor({ db: e.db, tmdb: makeFakeTmdb(), dataDir: join(tmp(), 'data'), contentDir: e.primary, probe, now: () => NOW });

    expect(await ingestor.scan()).toMatchObject({ ingested: 1, failed: 0 });
    expect(all(e.db, 'SELECT root_id FROM media_files')).toEqual([{ root_id: 1 }]);
  });
});
