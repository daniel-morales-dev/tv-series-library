import { describe, expect, it } from 'vitest';
import { airDateLabel, buildEpisodes, castOf, episodeAction, episodeSeen, playPlan, runtimeLabel, seasonFinished, seenToggle } from './titlePage.ts';
import type { Credit, Episode, MediaFile, Season, TitleDetail } from './types.ts';

const ep = (id: number, number: number): Episode => ({ id, number, name: `E${number}`, overview: null, runtimeMin: 24, stillPath: null, airDate: null });
const file = (id: number, episodeId: number | null, extra: Partial<MediaFile> = {}): MediaFile => ({
  id, status: 'ready', episodeId, extraLabel: null, durationS: 1000, audioTracks: [], subtitleTracks: [], ...extra,
});
const detail = (over: Partial<TitleDetail> = {}): TitleDetail =>
  ({
    id: 1, kind: 'series', title: 'S', seasons: [{ id: 1, number: 1, name: null, episodes: [ep(2, 2), ep(1, 1), ep(3, 3)] }],
    files: [file(11, 1), file(12, 2), file(13, 3), file(20, null, { extraLabel: 'OP' })], credits: [], progress: [], ...over,
  }) as TitleDetail;
const prog = (mediaFileId: number, positionS: number, completed = false) => ({ mediaFileId, positionS, durationS: 1000, completed });

describe('buildEpisodes', () => {
  it('orders by episode number and joins file and progress; extras excluded', () => {
    const [s] = buildEpisodes(detail({ progress: [prog(12, 300)] }));
    expect(s!.rows.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(s!.rows[1]).toMatchObject({ season: 1, file: { id: 12 }, progress: { positionS: 300 } });
    expect(s!.rows[0]!.progress).toBeNull();
  });
  it('keeps episodes without a file', () => {
    const [s] = buildEpisodes(detail({ files: [] }));
    expect(s!.rows[0]!.file).toBeNull();
  });
  it('prefers a playable file over an older downloading one for the same episode', () => {
    const [s] = buildEpisodes(detail({ files: [file(10, 1, { status: 'downloading' }), file(11, 1)] }));
    expect(s!.rows[0]).toMatchObject({ file: { id: 11 } });
  });
  it('picks the newest file when a stale ready row shadows a newer pending one', () => {
    const [s] = buildEpisodes(detail({ files: [file(42, 1), file(88, 1, { status: 'pending' })] }));
    expect(s!.rows[0]).toMatchObject({ file: { id: 88 } });
  });
  it('picks the newest file when two ready rows exist for the same episode', () => {
    const [s] = buildEpisodes(detail({ files: [file(42, 1), file(88, 1)] }));
    expect(s!.rows[0]).toMatchObject({ file: { id: 88 } });
  });
  it('picks the newest live file over an older downloading one', () => {
    const [s] = buildEpisodes(detail({ files: [file(42, 1, { status: 'downloading' }), file(88, 1, { status: 'pending' })] }));
    expect(s!.rows[0]).toMatchObject({ file: { id: 88 } });
  });
  it('picks the highest id when every file for an episode is downloading', () => {
    const [s] = buildEpisodes(detail({ files: [file(10, 1, { status: 'downloading' }), file(11, 1, { status: 'downloading' })] }));
    expect(s!.rows[0]).toMatchObject({ file: { id: 11 } });
  });
  it('still ignores extras attached to the episode', () => {
    const [s] = buildEpisodes(detail({ files: [file(20, 1, { extraLabel: 'OP' }), file(11, 1)] }));
    expect(s!.rows[0]).toMatchObject({ file: { id: 11 } });
  });
});

describe('season order', () => {
  const season = (number: number, airDate: string | null): Season => ({ id: number, number, name: null, airDate, episodes: [ep(number * 10, 1)] });
  it('orders by air date, undated seasons last, then number', () => {
    const d = detail({ seasons: [season(3, '2013-07-07'), season(4, '2012-12-31'), season(5, null)], files: [] });
    expect(buildEpisodes(d).map((s) => s.number)).toEqual([4, 3, 5]);
  });
  it('starts playback at the earliest season', () => {
    const d = detail({ seasons: [season(3, '2013-07-07'), season(4, '2012-12-31')], files: [file(41, 40), file(31, 30)] });
    expect(playPlan(d)).toMatchObject({ fileId: 41, label: 'Reproducir' });
  });
});

describe('episodeAction', () => {
  const row = (p: ReturnType<typeof prog> | null) => ({ progress: p }) as never;
  it('plays, resumes or rewatches', () => {
    expect(episodeAction(row(null))).toBe('play');
    expect(episodeAction(row(prog(1, 5)))).toBe('play');
    expect(episodeAction(row(prog(1, 300)))).toBe('resume');
    expect(episodeAction(row(prog(1, 1000, true)))).toBe('rewatch');
  });
});

describe('playPlan', () => {
  it('starts at the first episode when nothing was watched', () => {
    expect(playPlan(detail())).toMatchObject({ fileId: 11, action: 'play', label: 'Reproducir' });
  });
  it('resumes a partially watched episode', () => {
    expect(playPlan(detail({ progress: [prog(11, 1000, true), prog(12, 300)] }))).toMatchObject({ fileId: 12, action: 'resume', label: 'Continuar T1·E2' });
  });
  it('continues at the next episode after a finished one', () => {
    expect(playPlan(detail({ progress: [prog(11, 1000, true)] }))).toMatchObject({ fileId: 12, action: 'resume', label: 'Continuar T1·E2' });
  });
  it('offers rewatch when everything is done', () => {
    const all = [prog(11, 1000, true), prog(12, 1000, true), prog(13, 1000, true)];
    expect(playPlan(detail({ progress: all }))).toMatchObject({ fileId: 11, action: 'rewatch', label: 'Ver de nuevo' });
  });
  it('handles movies (no episodes)', () => {
    const movie = detail({ kind: 'movie', seasons: [], files: [file(5, null)] });
    expect(playPlan(movie)).toMatchObject({ fileId: 5, label: 'Reproducir' });
    expect(playPlan({ ...movie, progress: [prog(5, 400)] })).toMatchObject({ action: 'resume', label: 'Continuar' });
    expect(playPlan({ ...movie, progress: [prog(5, 1000, true)] })).toMatchObject({ action: 'rewatch' });
  });
  it('is null when there is nothing to play', () => {
    expect(playPlan(detail({ files: [] }))).toBeNull();
  });
});

describe('labels', () => {
  it('formats runtime', () => {
    expect(runtimeLabel(24, null)).toBe('24 min');
    expect(runtimeLabel(null, 1466)).toBe('24 min');
    expect(runtimeLabel(125, null)).toBe('2 h 5 min');
    expect(runtimeLabel(null, null)).toBeNull();
  });
  it('formats the air date in Spanish', () => {
    expect(airDateLabel('2009-07-17')).toBe('17 de julio de 2009');
    expect(airDateLabel(null)).toBeNull();
    expect(airDateLabel('nope')).toBeNull();
  });
});

describe('castOf', () => {
  it('keeps cast only, capped', () => {
    const c = (n: number, role: Credit['role']): Credit => ({ personId: n, name: `P${n}`, profilePath: null, role, character: null });
    expect(castOf([c(1, 'director'), c(2, 'cast'), c(3, 'cast')], 1).map((x) => x.personId)).toEqual([2]);
  });
});

describe('seasonFinished', () => {
  it('is true only when every episode that has a file is completed', () => {
    const all3 = [prog(11, 1000, true), prog(12, 1000, true), prog(13, 1000, true)];
    expect(seasonFinished(buildEpisodes(detail({ progress: all3 }))[0]!)).toBe(true);
    expect(seasonFinished(buildEpisodes(detail({ progress: all3.slice(0, 2) }))[0]!)).toBe(false);
    expect(seasonFinished(buildEpisodes(detail({ progress: [prog(11, 1000, true), prog(12, 1000, true), prog(13, 100)] }))[0]!)).toBe(false);
  });
  it('ignores episodes without a file and is false when no episode has one', () => {
    const d = detail({ files: [file(11, 1), file(12, 2)], progress: [prog(11, 1000, true), prog(12, 1000, true)] });
    expect(seasonFinished(buildEpisodes(d)[0]!)).toBe(true);
    expect(seasonFinished(buildEpisodes(detail({ files: [] }))[0]!)).toBe(false);
  });
});

describe('episodeSeen / seenToggle', () => {
  const row = (progress: ReturnType<typeof prog> | null) => ({ progress, file: file(11, 1) });
  it('is seen only when the file has completed progress', () => {
    expect(episodeSeen(row(prog(11, 1000, true)))).toBe(true);
    expect(episodeSeen(row(prog(11, 300)))).toBe(false);
    expect(episodeSeen(row(null))).toBe(false);
  });
  it('is unavailable without a file', () => {
    expect(seenToggle({ progress: null, file: null })).toBeNull();
  });
  it('offers the opposite action with an accessible label', () => {
    expect(seenToggle(row(null))).toEqual({ fileId: 11, finished: true, label: 'Marcar como visto' });
    expect(seenToggle(row(prog(11, 1000, true)))).toEqual({ fileId: 11, finished: false, label: 'Marcar como no visto' });
  });
});
