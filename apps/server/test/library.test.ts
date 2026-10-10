import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db/sql.ts';
import { addEpisode, addFile, addProfile, addTitle, setup } from './helpers.ts';

const put = (app: ReturnType<typeof setup>['app'], url: string, payload?: object) =>
  app.inject({ method: 'PUT', url, payload });

const progress = (db: DatabaseSync, profileId: number, fileId: number, pos: number, dur: number, at: string) =>
  run(db, 'INSERT INTO watch_progress VALUES (?, ?, ?, ?, ?, ?)', profileId, fileId, pos, dur, pos / dur >= 0.9 ? 1 : 0, at);

describe('my list API', () => {
  it('adds idempotently, lists and removes', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const t = addTitle(db, 'Film');
    expect((await put(app, `/api/profiles/${p}/my-list/${t}`)).statusCode).toBe(204);
    expect((await put(app, `/api/profiles/${p}/my-list/${t}`)).statusCode).toBe(204);
    const list = (await app.inject(`/api/profiles/${p}/my-list`)).json();
    expect(list.map((x: any) => x.title)).toEqual(['Film']);
    expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${p}/my-list/${t}` })).statusCode).toBe(204);
    expect((await app.inject(`/api/profiles/${p}/my-list`)).json()).toEqual([]);
  });

  it('returns 404 for unknown profile or title', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    expect((await put(app, `/api/profiles/${p}/my-list/99`)).statusCode).toBe(404);
    expect((await put(app, '/api/profiles/99/my-list/1')).statusCode).toBe(404);
    expect((await app.inject('/api/profiles/99/my-list')).statusCode).toBe(404);
  });
});

describe('progress API', () => {
  it('stores progress and marks completed at 90%', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const f = addFile(db, addTitle(db, 'Film'));
    expect((await put(app, `/api/profiles/${p}/progress`, { mediaFileId: f, positionS: 500, durationS: 1000 })).statusCode).toBe(204);
    expect(get<any>(db, 'SELECT completed FROM watch_progress').completed).toBe(0);
    await put(app, `/api/profiles/${p}/progress`, { mediaFileId: f, positionS: 900, durationS: 1000 });
    const rows = all<any>(db, 'SELECT * FROM watch_progress');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ position_s: 900, completed: 1 });
  });

  it('validates body and existence', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    expect((await put(app, `/api/profiles/${p}/progress`, { mediaFileId: 1, positionS: 1, durationS: 0 })).statusCode).toBe(400);
    expect((await put(app, `/api/profiles/${p}/progress`, { mediaFileId: 99, positionS: 1, durationS: 10 })).statusCode).toBe(404);
    const f = addFile(db, addTitle(db, 'Film'));
    expect((await put(app, `/api/profiles/99/progress`, { mediaFileId: f, positionS: 1, durationS: 10 })).statusCode).toBe(404);
  });
});

describe('continue watching', () => {
  const list = async (app: ReturnType<typeof setup>['app'], p: number) =>
    (await app.inject(`/api/profiles/${p}/continue-watching`)).json() as any[];

  it('resumes an incomplete file at its position', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const f = addFile(db, addTitle(db, 'Film'));
    progress(db, p, f, 300, 1000, '2026-01-01T00:00:00Z');
    const [item] = await list(app, p);
    expect(item).toMatchObject({ mediaFileId: f, positionS: 300, title: { title: 'Film' } });
  });

  it('moves to the next episode in season/episode order, skipping extras and unready files', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const t = addTitle(db, 'Show', { kind: 'series' });
    const s2e1 = addEpisode(db, t, 2, 1);
    const s1e2 = addEpisode(db, t, 1, 2);
    const s1e1 = addEpisode(db, t, 1, 1);
    addFile(db, t, { extraLabel: 'OP' });
    progress(db, p, s1e1, 950, 1000, '2026-01-01T00:00:00Z');
    progress(db, p, s1e2, 990, 1000, '2026-01-02T00:00:00Z');
    const [item] = await list(app, p);
    expect(item).toMatchObject({ mediaFileId: s2e1, positionS: 0, season: 2, episode: 1 });
  });

  it('exposes the target episode id and its still', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const t = addTitle(db, 'Show', { kind: 'series' });
    const e1 = addEpisode(db, t, 1, 1);
    const e2 = addEpisode(db, t, 1, 2);
    run(db, 'UPDATE episodes SET still_path = ? WHERE id = ?', 'stills/e2.jpg', get<any>(db, 'SELECT episode_id FROM media_files WHERE id = ?', e2).episode_id);
    progress(db, p, e1, 990, 1000, '2026-01-01T00:00:00Z');
    const [item] = await list(app, p);
    const epId = get<any>(db, 'SELECT episode_id FROM media_files WHERE id = ?', e2).episode_id;
    expect(item).toMatchObject({ mediaFileId: e2, episodeId: epId, stillPath: 'stills/e2.jpg' });
    const film = addFile(db, addTitle(db, 'Film'));
    progress(db, p, film, 100, 1000, '2026-01-03T00:00:00Z');
    expect((await list(app, p))[0]).toMatchObject({ mediaFileId: film, episodeId: null, stillPath: null });
  });

  it('omits titles with nothing left, hidden or finished, and orders by recency', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const done = addFile(db, addTitle(db, 'Done'));
    const hidden = addFile(db, addTitle(db, 'Hidden'));
    const older = addFile(db, addTitle(db, 'Older'));
    const newer = addFile(db, addTitle(db, 'Newer'));
    progress(db, p, done, 990, 1000, '2026-01-05T00:00:00Z');
    progress(db, p, hidden, 100, 1000, '2026-01-04T00:00:00Z');
    progress(db, p, older, 100, 1000, '2026-01-01T00:00:00Z');
    progress(db, p, newer, 100, 1000, '2026-01-03T00:00:00Z');
    const hiddenTitle = get<any>(db, 'SELECT title_id FROM media_files WHERE id = ?', hidden).title_id;
    expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${p}/continue-watching/${hiddenTitle}` })).statusCode).toBe(204);
    expect((await list(app, p)).map((i) => i.title.title)).toEqual(['Newer', 'Older']);
  });

  it('shows a hidden title again after new progress', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const t = addTitle(db, 'Film');
    const f = addFile(db, t);
    progress(db, p, f, 100, 1000, '2026-01-01T00:00:00Z');
    await app.inject({ method: 'DELETE', url: `/api/profiles/${p}/continue-watching/${t}` });
    expect(await list(app, p)).toEqual([]);
    await put(app, `/api/profiles/${p}/progress`, { mediaFileId: f, positionS: 200, durationS: 1000 });
    expect(await list(app, p)).toHaveLength(1);
  });

  it('keeps profiles isolated and 404s on unknown ones', async () => {
    const { app, db } = setup();
    const a = addProfile(db, 'a');
    const b = addProfile(db, 'b');
    progress(db, a, addFile(db, addTitle(db, 'Film')), 100, 1000, '2026-01-01T00:00:00Z');
    expect(await list(app, b)).toEqual([]);
    expect((await app.inject('/api/profiles/99/continue-watching')).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/profiles/${a}/continue-watching/99` })).statusCode).toBe(404);
  });
});

describe('finished', () => {
  it('true completes every file and removes the title from continue watching; false only unmarks', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const t = addTitle(db, 'Show', { kind: 'series' });
    const e1 = addEpisode(db, t, 1, 1);
    addEpisode(db, t, 1, 2);
    progress(db, p, e1, 100, 1000, '2026-01-01T00:00:00Z');

    expect((await put(app, `/api/profiles/${p}/titles/${t}/finished`, { finished: true })).statusCode).toBe(204);
    expect(all<any>(db, 'SELECT completed FROM watch_progress').map((r) => r.completed)).toEqual([1, 1]);
    expect((await app.inject(`/api/profiles/${p}/continue-watching`)).json()).toEqual([]);
    expect((await app.inject(`/api/titles/${t}?profileId=${p}`)).json().finished).toBe(true);

    await put(app, `/api/profiles/${p}/titles/${t}/finished`, { finished: false });
    expect(all<any>(db, 'SELECT completed FROM watch_progress')).toEqual([]);
    expect((await app.inject(`/api/titles/${t}?profileId=${p}`)).json().finished).toBe(false);
  });

  it('false clears per-episode progress of that profile and title only', async () => {
    const { app, db } = setup();
    const p = addProfile(db, 'a');
    const other = addProfile(db, 'b');
    const t = addTitle(db, 'Show', { kind: 'series' });
    const e1 = addEpisode(db, t, 1, 1);
    const e2 = addEpisode(db, t, 1, 2);
    const otherTitleFile = addFile(db, addTitle(db, 'Film'));
    progress(db, p, e1, 100, 1000, '2026-01-01T00:00:00Z');
    progress(db, p, e2, 100, 1000, '2026-01-01T00:00:00Z');
    progress(db, p, otherTitleFile, 100, 1000, '2026-01-01T00:00:00Z');
    progress(db, other, e1, 100, 1000, '2026-01-01T00:00:00Z');

    expect((await put(app, `/api/profiles/${p}/titles/${t}/finished`, { finished: false })).statusCode).toBe(204);
    expect(all<any>(db, 'SELECT profile_id, media_file_id FROM watch_progress ORDER BY profile_id, media_file_id')).toEqual([
      { profile_id: p, media_file_id: otherTitleFile },
      { profile_id: other, media_file_id: e1 },
    ]);
  });

  it('season true/false completes or clears only that season of that profile and title', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const other = addProfile(db, 'b');
    const t = addTitle(db, 'Show', { kind: 'series' });
    const s1a = addEpisode(db, t, 1, 1);
    const s1b = addEpisode(db, t, 1, 2);
    const s2a = addEpisode(db, t, 2, 1);
    const extra = addFile(db, t, { extraLabel: 'NCOP' });
    progress(db, p, s1a, 100, 1000, '2026-01-01T00:00:00Z');
    progress(db, other, s1b, 100, 1000, '2026-01-01T00:00:00Z');
    const done = () =>
      all<any>(db, 'SELECT profile_id, media_file_id, completed FROM watch_progress ORDER BY profile_id, media_file_id');

    expect((await put(app, `/api/profiles/${p}/titles/${t}/seasons/1/finished`, { finished: true })).statusCode).toBe(204);
    expect(done()).toEqual([
      { profile_id: p, media_file_id: s1a, completed: 1 },
      { profile_id: p, media_file_id: s1b, completed: 1 },
      { profile_id: other, media_file_id: s1b, completed: 0 },
    ]);
    expect(done().some((r) => r.media_file_id === s2a || r.media_file_id === extra)).toBe(false);

    expect((await put(app, `/api/profiles/${p}/titles/${t}/seasons/1/finished`, { finished: false })).statusCode).toBe(204);
    expect(done()).toEqual([{ profile_id: other, media_file_id: s1b, completed: 0 }]);
  });

  it('unmarking a season drops the title-level finished flag', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const t = addTitle(db, 'Show', { kind: 'series' });
    addEpisode(db, t, 1, 1);
    addEpisode(db, t, 2, 1);
    await put(app, `/api/profiles/${p}/titles/${t}/finished`, { finished: true });
    await put(app, `/api/profiles/${p}/titles/${t}/seasons/2/finished`, { finished: false });
    expect((await app.inject(`/api/titles/${t}?profileId=${p}`)).json().finished).toBe(false);
  });

  it('season endpoint 404s on unknown profile, title or season and validates the body', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const t = addTitle(db, 'Show', { kind: 'series' });
    addEpisode(db, t, 1, 1);
    const url = (pid: number, tid: number, n: number) => `/api/profiles/${pid}/titles/${tid}/seasons/${n}/finished`;
    expect((await put(app, url(99, t, 1), { finished: true })).statusCode).toBe(404);
    expect((await put(app, url(p, 99, 1), { finished: true })).statusCode).toBe(404);
    expect((await put(app, url(p, t, 7), { finished: true })).statusCode).toBe(404);
    expect((await put(app, url(p, t, 1), { finished: 'yes' })).statusCode).toBe(400);
  });

  it('file true/false completes or clears one episode, keeping prior position and dropping the title flag', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const other = addProfile(db, 'b');
    const t = addTitle(db, 'Show', { kind: 'series' });
    const e1 = addEpisode(db, t, 1, 1);
    const e2 = addEpisode(db, t, 1, 2);
    progress(db, p, e1, 100, 1000, '2026-01-01T00:00:00Z');
    progress(db, other, e1, 100, 1000, '2026-01-01T00:00:00Z');
    const url = (pid: number, f: number) => `/api/profiles/${pid}/media-files/${f}/finished`;
    const rows = () => all<any>(db, 'SELECT profile_id, media_file_id, position_s, duration_s, completed FROM watch_progress ORDER BY profile_id, media_file_id');

    expect((await put(app, url(p, e1), { finished: true })).statusCode).toBe(204);
    expect((await put(app, url(p, e2), { finished: true })).statusCode).toBe(204);
    expect(rows()).toEqual([
      { profile_id: p, media_file_id: e1, position_s: 100, duration_s: 1000, completed: 1 },
      { profile_id: p, media_file_id: e2, position_s: 1000, duration_s: 1000, completed: 1 },
      { profile_id: other, media_file_id: e1, position_s: 100, duration_s: 1000, completed: 0 },
    ]);

    await put(app, `/api/profiles/${p}/titles/${t}/finished`, { finished: true });
    expect((await put(app, url(p, e1), { finished: false })).statusCode).toBe(204);
    expect(rows().filter((r) => r.profile_id === p && r.media_file_id === e1)).toEqual([]);
    expect(rows()).toHaveLength(2);
    expect((await app.inject(`/api/titles/${t}?profileId=${p}`)).json().finished).toBe(false);
  });

  it('file endpoint 404s on unknown profile or file and validates the body', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    const f = addEpisode(db, addTitle(db, 'Show', { kind: 'series' }), 1, 1);
    expect((await put(app, `/api/profiles/99/media-files/${f}/finished`, { finished: true })).statusCode).toBe(404);
    expect((await put(app, `/api/profiles/${p}/media-files/99/finished`, { finished: true })).statusCode).toBe(404);
    expect((await put(app, `/api/profiles/${p}/media-files/${f}/finished`, { finished: 'yes' })).statusCode).toBe(400);
  });

  it('validates body and existence', async () => {
    const { app, db } = setup();
    const p = addProfile(db);
    expect((await put(app, `/api/profiles/${p}/titles/1/finished`, {})).statusCode).toBe(400);
    expect((await put(app, `/api/profiles/${p}/titles/99/finished`, { finished: true })).statusCode).toBe(404);
  });
});
