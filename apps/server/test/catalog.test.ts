import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { indexEntry } from '../src/modules/search/repository.ts';
import { run } from '../src/db/sql.ts';
import { addEpisode, addFile, addProfile, addTitle, setup } from './helpers.ts';

describe('catalog API', () => {
  it('filters and sorts titles', async () => {
    const { app, db } = setup();
    addTitle(db, 'Bravo', { kind: 'series', year: 2020, genres: ['Drama'] });
    addTitle(db, 'alpha', { kind: 'movie', year: 2010, genres: ['Drama', 'Crime'] });
    addTitle(db, 'Charlie', { kind: 'anime', year: 2024, genres: ['Action'] });

    const titles = async (qs: string) => (await app.inject(`/api/titles${qs}`)).json().map((t: any) => t.title);
    expect(await titles('?sort=title')).toEqual(['alpha', 'Bravo', 'Charlie']);
    expect(await titles('?sort=year')).toEqual(['Charlie', 'Bravo', 'alpha']);
    expect(await titles('?kind=series')).toEqual(['Bravo']);
    expect(await titles('?year=2010')).toEqual(['alpha']);
    expect(await titles('?genre=Drama&sort=title')).toEqual(['alpha', 'Bravo']);
    expect(await titles('?sort=title&limit=1&offset=1')).toEqual(['Bravo']);
    expect((await app.inject('/api/titles?kind=book')).statusCode).toBe(400);
  });

  it('returns detail with seasons, files of any status, saga and per-profile state', async () => {
    const { app, db } = setup();
    const collectionId = run(db, "INSERT INTO collections (tmdb_id, name) VALUES (1, 'Saga')").lastInsertId;
    const titleId = addTitle(db, 'Show', { kind: 'series' });
    run(db, 'UPDATE titles SET collection_id = ? WHERE id = ?', collectionId, titleId);
    const file = addEpisode(db, titleId, 1, 1);
    // T80: the stored ASS path must reach the player, which renders it with libass instead of the VTT copy.
    run(db, 'UPDATE media_files SET subtitle_tracks = ? WHERE id = ?', JSON.stringify([{ index: 0, language: 'jpn', title: null, supported: true, vtt: 'subs/0.vtt', ass: 'subs/0.ass' }]), file);
    addFile(db, titleId, { status: 'pending' });
    const personId = run(db, "INSERT INTO people (tmdb_id, name) VALUES (7, 'Actor')").lastInsertId;
    run(db, "INSERT INTO credits (title_id, person_id, role, character) VALUES (?, ?, 'cast', 'Hero')", titleId, personId);
    const profileId = addProfile(db);
    run(db, 'INSERT INTO my_list (profile_id, title_id) VALUES (?, ?)', profileId, titleId);
    run(db, "INSERT INTO watch_progress VALUES (?, ?, 100, 1000, 0, 't')", profileId, file);

    const plain = (await app.inject(`/api/titles/${titleId}`)).json();
    expect(plain.seasons[0].episodes).toHaveLength(1);
    expect(plain.files.map((f: any) => [f.id, f.status])).toEqual([[file, 'ready'], [file + 1, 'pending']]);
    expect(plain.files[0].subtitleTracks[0]).toMatchObject({ vtt: 'subs/0.vtt', ass: 'subs/0.ass' });
    expect(plain.credits[0]).toMatchObject({ name: 'Actor', character: 'Hero' });
    expect(plain.collection.titles).toHaveLength(1);
    expect(plain.inMyList).toBeUndefined();

    const withProfile = (await app.inject(`/api/titles/${titleId}?profileId=${profileId}`)).json();
    expect(withProfile).toMatchObject({ inMyList: true, finished: false });
    expect(withProfile.progress).toEqual([{ mediaFileId: file, positionS: 100, durationS: 1000, completed: false }]);
  });

  it('returns 404 for unknown title', async () => {
    const { app } = setup();
    expect((await app.inject('/api/titles/99')).statusCode).toBe(404);
  });

  // T87: repairing subtitles rewrites them in place; the version in the URL is what makes the player
  // (and any browser cache) pick the fixed copy without a manual refresh.
  it('versions subtitle URLs with the package mtime', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tvlib-subs-'));
    const { db } = setup();
    const app = buildApp({ db, dataDir });
    const titleId = addTitle(db, 'Show', { kind: 'series' });
    const file = addEpisode(db, titleId, 1, 1);
    run(
      db,
      'UPDATE media_files SET subtitle_tracks = ? WHERE id = ?',
      JSON.stringify([{ index: 0, language: 'spa', vtt: 'subs/0.vtt', ass: 'subs/0.ass' }]),
      file,
    );
    const subs = join(dataDir, 'hls', String(file), 'subs');
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, '0.vtt'), 'WEBVTT');
    writeFileSync(join(subs, '0.ass'), '[Script Info]');

    const vv = Math.floor(statSync(join(subs, '0.vtt')).mtimeMs);
    const va = Math.floor(statSync(join(subs, '0.ass')).mtimeMs);
    const detail = (await app.inject(`/api/titles/${titleId}`)).json();
    expect(detail.files[0].subtitleTracks[0]).toMatchObject({ vtt: `subs/0.vtt?v=${vv}`, ass: `subs/0.ass?v=${va}` });

    // A file whose package is not on disk keeps the plain path: nothing to version yet.
    const other = addFile(db, titleId, {});
    run(db, 'UPDATE media_files SET subtitle_tracks = ? WHERE id = ?', JSON.stringify([{ vtt: 'subs/0.vtt' }]), other);
    const again = (await app.inject(`/api/titles/${titleId}`)).json();
    expect(again.files[1].subtitleTracks[0].vtt).toBe('subs/0.vtt');
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('search API', () => {
  it('suggests by prefix of each word, ignoring accents, for titles and people', async () => {
    const { app, db } = setup();
    indexEntry(db, 'title', 1, 'Más allá del final');
    indexEntry(db, 'title', 2, 'Otro título');
    indexEntry(db, 'person', 5, 'Máximo Actor');

    const suggest = async (q: string) => (await app.inject({ url: '/api/search/suggest', query: { q } })).json();
    expect(await suggest('mas al')).toEqual([{ type: 'title', id: 1, label: 'Más allá del final' }]);
    expect(await suggest('ma')).toHaveLength(2);
    expect(await suggest('titu')).toHaveLength(1);
    expect(await suggest('"*(')).toEqual([]);
  });

  it('requires q', async () => {
    const { app } = setup();
    expect((await app.inject('/api/search/suggest')).statusCode).toBe(400);
  });
});

describe('comingSoon', () => {
  it('is true only when the title has files and all of them are downloading', async () => {
    const { app, db } = setup();
    const empty = addTitle(db, 'Empty', { kind: 'series' });
    const soon = addTitle(db, 'Soon', { kind: 'series' });
    addFile(db, soon, { status: 'downloading' });
    const mixed = addTitle(db, 'Mixed', { kind: 'series' });
    addFile(db, mixed, { status: 'downloading' });
    addFile(db, mixed, { status: 'pending' });

    const flags = Object.fromEntries((await app.inject('/api/titles')).json().map((t: any) => [t.title, t.comingSoon]));
    expect(flags).toEqual({ Empty: false, Soon: true, Mixed: false });
    expect((await app.inject(`/api/titles/${soon}`)).json()).toMatchObject({ comingSoon: true });
    expect((await app.inject(`/api/titles/${empty}`)).json()).toMatchObject({ comingSoon: false });
  });
});
