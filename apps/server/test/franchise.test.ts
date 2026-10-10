import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { all, get } from '../src/db/sql.ts';
import { createIngestor } from '../src/modules/ingest/ingestor.ts';
import { makeFakeTmdb } from './fake-tmdb.ts';
import { addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const link = (app: ReturnType<typeof setup>['app'], id: number, payload: object) =>
  app.inject({ method: 'POST', url: `/api/titles/${id}/franchise`, payload });
const detail = async (app: ReturnType<typeof setup>['app'], id: number) => (await app.inject(`/api/titles/${id}`)).json();

describe('franchise endpoints', () => {
  it('links sequels in order, reusing the franchise, and getTitleDetail lists the siblings', async () => {
    const { app, db } = setup();
    const a = addTitle(db, 'Monogatari', { kind: 'anime', year: 2009 });
    const b = addTitle(db, 'Nisemonogatari', { kind: 'anime', year: 2012 });
    const c = addTitle(db, 'Kizumonogatari', { kind: 'movie', year: 2016 });

    expect((await detail(app, a)).franchise).toBeNull();
    expect((await link(app, b, { ofTitleId: a })).statusCode).toBe(200);
    expect((await link(app, c, { ofTitleId: b })).statusCode).toBe(200);
    expect(all(db, 'SELECT id FROM franchises')).toHaveLength(1);

    const f = (await detail(app, b)).franchise;
    expect(f).toMatchObject({ name: 'Monogatari' });
    expect(f.items).toEqual([
      { id: a, name: 'Monogatari', posterPath: null, kind: 'anime', year: 2009, order: 1, current: false },
      { id: b, name: 'Nisemonogatari', posterPath: null, kind: 'anime', year: 2012, order: 2, current: true },
      { id: c, name: 'Kizumonogatari', posterPath: null, kind: 'movie', year: 2016, order: 3, current: false },
    ]);
  });

  it('a prequel goes first', async () => {
    const { app, db } = setup();
    const a = addTitle(db, 'Second', { kind: 'anime' });
    const b = addTitle(db, 'Third', { kind: 'anime' });
    const p = addTitle(db, 'First', { kind: 'anime' });
    await link(app, b, { ofTitleId: a });
    expect((await link(app, p, { ofTitleId: a, relation: 'prequel' })).statusCode).toBe(200);
    expect((await detail(app, a)).franchise.items.map((i: any) => i.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('moving a title to another franchise drops the one left with a single member', async () => {
    const { app, db } = setup();
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => addTitle(db, n, { kind: 'series' }));
    await link(app, b, { ofTitleId: a });
    await link(app, d, { ofTitleId: c });
    await link(app, b, { ofTitleId: c });
    expect(all(db, 'SELECT id FROM franchises')).toHaveLength(1);
    expect((await detail(app, a)).franchise).toBeNull();
    expect((await detail(app, c)).franchise.items.map((i: any) => i.name)).toEqual(['C', 'D', 'B']);
  });

  it('rejects unknown titles, itself and a bad relation', async () => {
    const { app, db } = setup();
    const a = addTitle(db, 'A');
    const b = addTitle(db, 'B');
    expect((await link(app, a, { ofTitleId: 999 })).statusCode).toBe(404);
    expect((await link(app, 999, { ofTitleId: a })).statusCode).toBe(404);
    expect((await link(app, a, { ofTitleId: a })).statusCode).toBe(400);
    expect((await link(app, a, { ofTitleId: b, relation: 'spin-off' })).statusCode).toBe(400);
    expect(all(db, 'SELECT id FROM franchises')).toHaveLength(0);
  });

  it('unlinks a title and removes a franchise that is left with one member', async () => {
    const { app, db } = setup();
    const a = addTitle(db, 'A');
    const b = addTitle(db, 'B');
    const c = addTitle(db, 'C');
    await link(app, b, { ofTitleId: a });
    await link(app, c, { ofTitleId: a });

    const del = (id: number) => app.inject({ method: 'DELETE', url: `/api/titles/${id}/franchise` });
    expect((await del(c)).statusCode).toBe(204);
    expect((await detail(app, c)).franchise).toBeNull();
    expect((await detail(app, a)).franchise.items).toHaveLength(2);
    expect((await del(b)).statusCode).toBe(204);
    expect(all(db, 'SELECT id FROM franchises')).toHaveLength(0);
    expect(get<any>(db, 'SELECT franchise_id, franchise_order FROM titles WHERE id = ?', a)).toEqual({ franchise_id: null, franchise_order: null });
    expect((await del(b)).statusCode).toBe(404);
    expect((await del(999)).statusCode).toBe(404);
  });
});

describe('pending confirm with a franchise', () => {
  function env() {
    const root = mkdtempSync(join(tmpdir(), 'tvlib-fr-'));
    roots.push(root);
    const contentDir = join(root, 'content');
    const { db } = setup();
    const NOW = Date.parse('2026-01-01T12:00:00Z');
    const ingestor = createIngestor({
      db,
      tmdb: makeFakeTmdb(),
      dataDir: join(root, 'data'),
      contentDir,
      now: () => NOW,
      probe: async () => ({ durationS: 100, audio: [], subtitles: [] }),
    });
    const app = buildApp({ db, dataDir: join(root, 'data'), ingestor });
    const addFile = (rel: string) => {
      const abs = join(contentDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, 'x');
      utimesSync(abs, (NOW - 3_600_000) / 1000, (NOW - 3_600_000) / 1000);
    };
    const confirm = async (payload: object) => {
      const [row] = (await app.inject('/api/pending')).json();
      return app.inject({ method: 'POST', url: `/api/pending/${row.id}/confirm`, payload });
    };
    return { db, app, ingestor, addFile, confirm };
  }

  it('creates the franchise from the other title (series and movie) and keeps order', async () => {
    const e = env();
    const first = addTitle(e.db, 'Original', { kind: 'anime' });
    e.addFile('shows/zzz/zzz S02E01.mkv');
    await e.ingestor.scan();
    const res = await e.confirm({ tmdbType: 'tv', tmdbId: 100, franchiseOfTitleId: first });
    expect(res.statusCode).toBe(200);
    const { titleId } = res.json();
    expect((await detail(e.app, titleId)).franchise.items.map((i: any) => [i.name, i.order])).toEqual([['Original', 1], ['Plain Show', 2]]);

    e.addFile('films/Weird Name.mkv');
    await e.ingestor.scan();
    const m = await e.confirm({ tmdbType: 'movie', tmdbId: 27205, franchiseOfTitleId: first, franchiseRelation: 'prequel' });
    expect(m.statusCode).toBe(200);
    expect((await detail(e.app, first)).franchise.items.map((i: any) => i.name)).toEqual(['Origen', 'Original', 'Plain Show']);
    expect(all(e.db, 'SELECT id FROM franchises')).toHaveLength(1);
  });

  it('rejects an unknown franchise title before touching the pending file', async () => {
    const e = env();
    e.addFile('shows/zzz/zzz S02E01.mkv');
    await e.ingestor.scan();
    expect((await e.confirm({ tmdbType: 'tv', tmdbId: 100, franchiseOfTitleId: 999 })).statusCode).toBe(404);
    expect((await e.app.inject('/api/pending')).json()).toHaveLength(1);
    expect(all(e.db, 'SELECT id FROM titles')).toHaveLength(0);
    expect((await e.confirm({ tmdbType: 'tv', tmdbId: 100, franchiseOfTitleId: 1, franchiseRelation: 'x' })).statusCode).toBe(400);
  });
});
