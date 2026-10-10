import { describe, expect, it } from 'vitest';
import { pickRandom, type Candidate } from '../src/modules/random/pick.ts';
import { run } from '../src/db/sql.ts';
import { addEpisode, addFile, addProfile, addTitle, setup } from './helpers.ts';

const cand = (mediaFileId: number, o: Partial<Candidate> = {}): Candidate => ({
  mediaFileId,
  titleId: 1,
  episodic: false,
  watched: false,
  ...o,
});

describe('pickRandom', () => {
  it('returns undefined when there is nothing to play', () => {
    expect(pickRandom([])).toBeUndefined();
  });

  it('picks uniformly among candidates when nothing is watched or episodic', () => {
    const list = [cand(1), cand(2), cand(3)];
    expect(pickRandom(list, () => 0)?.mediaFileId).toBe(1);
    expect(pickRandom(list, () => 0.99)?.mediaFileId).toBe(3);
  });

  it('prefers unseen episodes over watched ones, but keeps movies in the pool', () => {
    const list = [cand(1, { episodic: true, watched: true }), cand(2, { episodic: true }), cand(3)];
    const picks = [0, 0.25, 0.5, 0.75, 0.99].map((r) => pickRandom(list, () => r)?.mediaFileId);
    expect(picks).not.toContain(1);
    expect(new Set(picks)).toEqual(new Set([2, 3]));
  });

  it('falls back to watched episodes when every episode is seen', () => {
    const list = [cand(1, { episodic: true, watched: true }), cand(2, { episodic: true, watched: true })];
    expect(pickRandom(list, () => 0)?.mediaFileId).toBe(1);
    expect(pickRandom(list, () => 0.99)?.mediaFileId).toBe(2);
  });
});

describe('GET /api/random', () => {
  it('404 when nothing is ready to play', async () => {
    const { app, db } = setup();
    const titleId = addTitle(db, 'Show', { kind: 'series' });
    addFile(db, titleId, { status: 'downloading' });
    expect((await app.inject('/api/random')).statusCode).toBe(404);
  });

  it('ignores extras, non-ready files and only plays ready ones', async () => {
    const { app, db } = setup();
    const titleId = addTitle(db, 'Film', { kind: 'movie' });
    addFile(db, titleId, { extraLabel: 'Trailer' });
    addFile(db, titleId, { status: 'processing' });
    const ready = addFile(db, titleId);
    const res = await app.inject('/api/random');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ titleId, mediaFileId: ready });
  });

  it('filters by kind', async () => {
    const { app, db } = setup();
    const movie = addTitle(db, 'Film', { kind: 'movie' });
    addFile(db, movie);
    const anime = addTitle(db, 'Anime', { kind: 'anime' });
    const animeFile = addEpisode(db, anime, 1, 1);
    expect((await app.inject('/api/random?kind=anime')).json()).toEqual({ titleId: anime, mediaFileId: animeFile });
    expect((await app.inject('/api/random?kind=series')).statusCode).toBe(404);
    expect((await app.inject('/api/random?kind=book')).statusCode).toBe(400);
  });

  it('prefers an episode the profile has not finished', async () => {
    const { app, db } = setup();
    const show = addTitle(db, 'Show', { kind: 'series' });
    const seen = addEpisode(db, show, 1, 1);
    const unseen = addEpisode(db, show, 1, 2);
    const profile = addProfile(db);
    run(
      db,
      'INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, completed, updated_at) VALUES (?, ?, 1000, 1000, 1, ?)',
      profile,
      seen,
      't',
    );
    for (let i = 0; i < 10; i++) {
      expect((await app.inject(`/api/random?kind=series&profile=${profile}`)).json().mediaFileId).toBe(unseen);
    }
  });

  it('plays any episode when all of them are seen', async () => {
    const { app, db } = setup();
    const show = addTitle(db, 'Show', { kind: 'series' });
    const only = addEpisode(db, show, 1, 1);
    const profile = addProfile(db);
    run(
      db,
      'INSERT INTO watch_progress (profile_id, media_file_id, position_s, duration_s, completed, updated_at) VALUES (?, ?, 1000, 1000, 1, ?)',
      profile,
      only,
      't',
    );
    expect((await app.inject(`/api/random?kind=series&profile=${profile}`)).json()).toEqual({ titleId: show, mediaFileId: only });
  });
});
