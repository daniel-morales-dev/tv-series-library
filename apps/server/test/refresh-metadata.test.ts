import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db/connection.ts';
import { run } from '../src/db/sql.ts';
import { makeFakeTmdb, type FakeTmdb } from './fake-tmdb.ts';
import { addTitle } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(tmdb: FakeTmdb) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tvlib-refresh-'));
  dirs.push(dataDir);
  const db = openDb(':memory:');
  const app = buildApp({ db, dataDir, tmdb });
  return { db, app, dataDir };
}

const addLinkedTitle = (db: ReturnType<typeof openDb>) =>
  run(
    db,
    "INSERT INTO titles (tmdb_type, tmdb_id, kind, title, metadata_status) VALUES ('tv', 46195, 'series', 'Nombre viejo', 'ready')",
  ).lastInsertId;

const refresh = (app: ReturnType<typeof buildApp>, id: number) =>
  app.inject({ method: 'POST', url: `/api/titles/${id}/refresh-metadata` });

describe('POST /api/titles/:id/refresh-metadata', () => {
  it('re-queries TMDB and updates the stored metadata and images; repeating it is idempotent', async () => {
    const tmdb = makeFakeTmdb();
    const { app, db, dataDir } = setup(tmdb);
    const id = addLinkedTitle(db);
    run(db, "UPDATE titles SET overview = NULL, poster_path = NULL, rating = NULL, genres = '[]' WHERE id = ?", id);

    const first = await refresh(app, id);
    expect(first.statusCode).toBe(200);
    expect(tmdb.calls).toContain('tv:46195');

    const detail = (await app.inject(`/api/titles/${id}`)).json();
    expect(detail).toMatchObject({
      title: 'Monogatari',
      overview: 'Serie de novelas ligeras.',
      year: 2009,
      rating: 8.4,
      genres: ['Animación'],
      posterPath: 'w500/mono.jpg',
      backdropPath: 'w1280/mono-bd.jpg',
      metadataStatus: 'ready',
    });
    expect(existsSync(join(dataDir, 'images', 'w500', 'mono.jpg'))).toBe(true);

    const again = await refresh(app, id);
    expect(again.statusCode).toBe(200);
    expect((await app.inject(`/api/titles/${id}`)).json()).toEqual(detail);
  });

  it('answers 502 with a Spanish message and changes nothing when TMDB is unreachable', async () => {
    const tmdb = makeFakeTmdb({ offline: true });
    const { app, db } = setup(tmdb);
    const id = addLinkedTitle(db);
    const before = (await app.inject(`/api/titles/${id}`)).json();

    const res = await refresh(app, id);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'tmdb_unavailable' });
    expect(res.json().message).toBe('No se pudo consultar TMDB. Inténtalo de nuevo cuando haya conexión.');
    expect((await app.inject(`/api/titles/${id}`)).json()).toEqual(before);
  });

  it('answers 404 for an unknown title', async () => {
    const { app } = setup(makeFakeTmdb());
    const res = await refresh(app, 99);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect(res.json().message).toBe('No se encontró el título.');
  });

  it('answers 409 and changes nothing for a title with no TMDB link', async () => {
    const { app, db } = setup(makeFakeTmdb());
    const id = addTitle(db, 'Local', { kind: 'series' });

    const res = await refresh(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_linked' });
    const detail = (await app.inject(`/api/titles/${id}`)).json();
    expect(detail).toMatchObject({ title: 'Local', metadataStatus: 'pending' });
  });
});
