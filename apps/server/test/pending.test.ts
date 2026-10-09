import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { all, get } from '../src/db/sql.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = Date.parse('2026-01-01T12:00:00Z');

function env() {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-api-'));
  roots.push(root);
  const contentDir = join(root, 'content');
  const dataDir = join(root, 'data');
  const { db } = setup();
  let unreadable = '';
  const ingestor = createIngestor({
    db,
    tmdb: makeFakeTmdb(),
    dataDir,
    contentDir,
    now: () => NOW,
    probe: async (path) => {
      if (path === unreadable) throw new Error('bad');
      return { durationS: 100, audio: [], subtitles: [] };
    },
  });
  const app = buildApp({ db, dataDir, ingestor });
  const addFile = (rel: string) => {
    const abs = join(contentDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    const t = (NOW - 3_600_000) / 1000;
    utimesSync(abs, t, t);
    return abs;
  };
  return { db, app, ingestor, addFile, dataDir, breakFile: (abs: string) => (unreadable = abs) };
}

describe('pending API', () => {
  it('lists open pending files and hides ignored ones', async () => {
    const e = env();
    e.addFile('shows/zzz/zzz 01.mkv');
    e.addFile('shows/zzz/zzz 02.mkv');
    await e.ingestor.scan();

    const list = (await e.app.inject('/api/pending')).json();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ path: 'shows/zzz/zzz 01.mkv', reason: 'no_match', parsed: { kind: 'episode', number: 1 } });
    expect(list[0].candidates.map((c: any) => c.tmdbId)).toEqual([100, 46195]);

    expect((await e.app.inject({ method: 'POST', url: `/api/pending/${list[0].id}/ignore` })).statusCode).toBe(204);
    expect((await e.app.inject({ method: 'POST', url: `/api/pending/${list[0].id}/ignore` })).statusCode).toBe(404);
    expect((await e.app.inject('/api/pending')).json()).toHaveLength(1);
    await e.ingestor.scan();
    expect(all(e.db, 'SELECT id FROM pending_files')).toHaveLength(2); // ignored files are not re-added
  });

  it('confirm adopts the folder and places its pending siblings', async () => {
    const e = env();
    e.addFile('shows/zzz/zzz S02E01.mkv');
    e.addFile('shows/zzz/zzz S02E02.mkv');
    e.addFile('shows/zzz/zzz S09E01.mkv');
    await e.ingestor.scan();
    const [first] = (await e.app.inject('/api/pending')).json();

    const res = await e.app.inject({ method: 'POST', url: `/api/pending/${first.id}/confirm`, payload: { tmdbType: 'tv', tmdbId: 100 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ placed: 2 });
    expect(get<any>(e.db, 'SELECT title FROM titles')?.title).toBe('Plain Show');
    expect(all<any>(e.db, 'SELECT e.number FROM media_files m JOIN episodes e ON e.id = m.episode_id ORDER BY e.number')).toHaveLength(2);
    const left = (await e.app.inject('/api/pending')).json();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ path: 'shows/zzz/zzz S09E01.mkv', reason: 'unmapped_episode' });
  });

  it('confirm accepts a manual season/episode or extra label for a single file', async () => {
    const e = env();
    e.addFile('shows/Plain Show/making of.mkv');
    e.addFile('shows/Plain Show/bloopers.mkv');
    await e.ingestor.scan();
    const [a, b] = (await e.app.inject('/api/pending')).json();
    const confirm = (id: number, payload: object) => e.app.inject({ method: 'POST', url: `/api/pending/${id}/confirm`, payload: { tmdbType: 'tv', tmdbId: 100, ...payload } });

    expect((await confirm(a.id, {})).statusCode).toBe(422);
    expect((await confirm(a.id, { season: 1, episode: 2 })).statusCode).toBe(200);
    expect((await confirm(b.id, { extraLabel: 'Bloopers' })).statusCode).toBe(200);
    expect(all<any>(e.db, 'SELECT extra_label, episode_id IS NOT NULL AS linked FROM media_files ORDER BY id')).toEqual([
      { extra_label: null, linked: 1 },
      { extra_label: 'Bloopers', linked: 0 },
    ]);
    expect((await confirm(a.id, {})).statusCode).toBe(404);
  });

  it('confirms a movie and a group ordering, and validates the body', async () => {
    const e = env();
    e.addFile('films/Weird Name.mkv');
    e.addFile('shows/mystery/mystery 03.mkv');
    await e.ingestor.scan();
    const [movie, show] = (await e.app.inject('/api/pending')).json();
    const post = (id: number, payload: object) => e.app.inject({ method: 'POST', url: `/api/pending/${id}/confirm`, payload });

    expect((await post(movie.id, { tmdbType: 'book', tmdbId: 1 })).statusCode).toBe(400);
    expect((await post(movie.id, { tmdbType: 'movie', tmdbId: 27205 })).statusCode).toBe(200);
    expect(get<any>(e.db, "SELECT title FROM titles WHERE kind = 'movie'")?.title).toBe('Origen');

    expect((await post(show.id, { tmdbType: 'tv', tmdbId: 46195, episodeGroupId: 'g_air' })).statusCode).toBe(400); // folder matches no group
    const res = await post(show.id, { tmdbType: 'tv', tmdbId: 46195, episodeGroupId: 'g_air', season: 2 });
    expect(res.statusCode).toBe(200);
    expect(get<any>(e.db, 'SELECT s.name FROM media_files m JOIN episodes e ON e.id = m.episode_id JOIN seasons s ON s.id = e.season_id')?.name).toBe('Nisemonogatari');
  });

  it('keeps the file pending when it cannot be read', async () => {
    const e = env();
    const abs = e.addFile('shows/zzz/zzz S01E01.mkv');
    await e.ingestor.scan();
    const [row] = (await e.app.inject('/api/pending')).json();
    e.breakFile(abs);
    const res = await e.app.inject({ method: 'POST', url: `/api/pending/${row.id}/confirm`, payload: { tmdbType: 'tv', tmdbId: 100 } });
    expect(res.statusCode).toBe(409);
    expect(all(e.db, 'SELECT id FROM media_files')).toHaveLength(0);
    expect((await e.app.inject('/api/pending')).json()).toHaveLength(1);
  });
});

describe('scan and images endpoints', () => {
  it('forces a scan and reports the summary', async () => {
    const e = env();
    e.addFile('shows/Plain Show/Plain Show S01E01.mkv');
    const res = await e.app.inject({ method: 'POST', url: '/api/ingest/scan' });
    expect(res.json()).toMatchObject({ ingested: 1, pending: 0 });
  });

  it('answers 503 for scan and confirm when ingestion is off', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/ingest/scan' })).statusCode).toBe(503);
  });

  it('serves stored images and refuses traversal', async () => {
    const e = env();
    mkdirSync(join(e.dataDir, 'images', 'w500'), { recursive: true });
    writeFileSync(join(e.dataDir, 'images', 'w500', 'a.jpg'), 'JPEG');
    writeFileSync(join(e.dataDir, 'secret.jpg'), 'SECRET');
    symlinkSync(join(e.dataDir, 'secret.jpg'), join(e.dataDir, 'images', 'w500', 'link.jpg'));

    const ok = await e.app.inject('/api/images/w500/a.jpg');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.body).toBe('JPEG');
    for (const bad of ['/api/images/../secret.jpg', '/api/images/..%2Fsecret.jpg', '/api/images/w500/%2e%2e/%2e%2e/secret.jpg', '/api/images/w500/link.jpg', '/api/images/w500/missing.jpg', '/api/images/w500/a.txt']) {
      const res = await e.app.inject(bad);
      expect(res.statusCode, bad).toBe(404);
      expect(res.body).not.toContain('SECRET');
    }
  });
});
