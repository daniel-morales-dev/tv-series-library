import { describe, expect, it } from 'vitest';
import { langSummary, restoreAt, sortMyList, statusLine } from './listPage.ts';
import type { TitleDetail, TitleSummary } from './types.ts';

const s = (id: number, over: Partial<TitleSummary> = {}): TitleSummary => ({
  id, kind: 'anime', title: `T${id}`, originalTitle: null, overview: null, year: 2020, runtimeMin: null,
  rating: null, genres: [], posterPath: null, backdropPath: null, logoPath: null, comingSoon: false, ...over,
});
const file = (id: number, episodeId: number | null) => ({ id, status: 'ready' as const, episodeId, extraLabel: null, durationS: 100, audioTracks: [], subtitleTracks: [] });
const ep = (id: number, number: number) => ({ id, number, name: null, overview: null, runtimeMin: null, stillPath: null, airDate: null });
const series = (progress: TitleDetail['progress']): TitleDetail => ({
  ...s(1),
  seasons: [{ id: 1, number: 1, name: null, episodes: [ep(1, 1), ep(2, 2), ep(3, 3)] }],
  files: [file(10, 1), file(11, 2), file(12, 3)],
  credits: [],
  progress,
});
const done = (id: number) => ({ mediaFileId: id, positionS: 100, durationS: 100, completed: true });

describe('statusLine', () => {
  it('starts from the first episode', () => expect(statusLine(series([]))).toBe('Comenzar a ver: T1·E1'));
  it('continues with the first unfinished episode', () => expect(statusLine(series([done(10), done(11)]))).toBe('Continuar: T1·E3'));
  it('offers a rewatch once everything is done', () => expect(statusLine(series([done(10), done(11), done(12)]))).toBe('Ver de nuevo: T1·E1'));
  it('movies carry no episode tag', () => {
    const movie: TitleDetail = { ...s(2, { kind: 'movie' }), seasons: [], files: [file(20, null)], credits: [], progress: [{ mediaFileId: 20, positionS: 50, durationS: 100, completed: false }] };
    expect(statusLine(movie)).toBe('Continuar');
  });
  it('is empty without playable files', () => expect(statusLine({ ...series([]), files: [], seasons: [] })).toBe(''));
});

describe('langSummary', () => {
  it('joins audio and subs, capping long lists', () => {
    expect(langSummary({ audio: ['Japonés'], subs: ['Inglés', 'Español', 'Francés', 'Alemán'] })).toBe('Audio Japonés · Sub Inglés, Español, Francés +1');
  });
  it('is empty when nothing is known', () => expect(langSummary({ audio: [], subs: [] })).toBe(''));
});

describe('sortMyList', () => {
  const items = [s(1, { title: 'Zeta', year: 2001 }), s(2, { title: 'álef', year: null }), s(3, { title: 'Beta', year: 2015 })];
  it('title: locale order', () => expect(sortMyList(items, 'title', {}).map((x) => x.id)).toEqual([2, 3, 1]));
  it('year: newest first, unknown last', () => expect(sortMyList(items, 'year', {}).map((x) => x.id)).toEqual([3, 1, 2]));
  it('recent: watched first by last activity, then list order', () =>
    expect(sortMyList(items, 'recent', { 1: '2026-01-01', 3: '2026-02-01' }).map((x) => x.id)).toEqual([3, 1, 2]));
  it('does not mutate', () => {
    sortMyList(items, 'title', {});
    expect(items.map((x) => x.id)).toEqual([1, 2, 3]);
  });
});

describe('restoreAt', () => {
  it('puts the item back, clamped', () => {
    expect(restoreAt([1, 3], 2, 1)).toEqual([1, 2, 3]);
    expect(restoreAt([1], 2, 9)).toEqual([1, 2]);
  });
});
