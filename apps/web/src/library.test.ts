import { describe, expect, it } from 'vitest';
import {
  avatarColor,
  episodeLabel,
  firstFileId,
  groupByGenre,
  initial,
  pickHeroes,
  progressPct,
  remainingLabel,
  remainingMinutes,
  toggleInList,
} from './library.ts';
import type { ContinueItem, TitleSummary } from './types.ts';

const t = (id: number, over: Partial<TitleSummary> = {}): TitleSummary => ({
  id, kind: 'series', title: `T${id}`, originalTitle: null, overview: null, year: 2020, runtimeMin: null,
  rating: null, genres: [], posterPath: null, backdropPath: `w1280/${id}.jpg`, logoPath: null, ...over,
});
const cont = (title: TitleSummary): ContinueItem => ({
  title, mediaFileId: title.id * 10, positionS: 100, durationS: 1000, season: 1, episode: 2, episodeName: 'x', updatedAt: '',
});

describe('remaining time', () => {
  it('rounds up to whole minutes', () => {
    expect(remainingMinutes(0, 1466)).toBe(25);
    expect(remainingMinutes(1400, 1466)).toBe(2);
  });
  it('is null without a duration and never negative', () => {
    expect(remainingMinutes(10, null)).toBeNull();
    expect(remainingMinutes(2000, 1000)).toBe(0);
  });
  it('formats minutes and hours', () => {
    expect(remainingLabel(0, 1466)).toBe('25m restantes');
    expect(remainingLabel(0, 3900)).toBe('1h 05m restantes');
    expect(remainingLabel(990, 1000)).toBe('1m restante');
    expect(remainingLabel(0, null)).toBeNull();
  });
  it('clamps progress to 0..100', () => {
    expect(progressPct(250, 1000)).toBe(25);
    expect(progressPct(5000, 1000)).toBe(100);
    expect(progressPct(5, null)).toBe(0);
  });
});

describe('episodeLabel', () => {
  it('joins season, episode and name', () => {
    expect(episodeLabel(1, 3, 'Hitagi')).toBe('T1 · E3 — Hitagi');
    expect(episodeLabel(2, 10, null)).toBe('T2 · E10');
  });
  it('is empty for movies', () => {
    expect(episodeLabel(null, null, null)).toBe('');
  });
});

describe('pickHeroes', () => {
  it('puts continue-watching first, skips titles without backdrop, caps the count', () => {
    const a = t(1), b = t(2), c = t(3, { backdropPath: null }), d = t(4);
    const picks = pickHeroes([a, b, c, d], [cont(d)], 2);
    expect(picks.map((p) => p.title.id)).toEqual([4, 1]);
    expect(picks[0]!.resume?.mediaFileId).toBe(40);
    expect(picks[1]!.resume).toBeNull();
  });
  it('returns nothing for an empty library', () => {
    expect(pickHeroes([], [])).toEqual([]);
  });
});

describe('groupByGenre', () => {
  const list = [t(1, { genres: ['Drama', 'Comedia'] }), t(2, { genres: ['Drama'] }), t(3, { genres: ['Acción'] })];
  it('orders by size then name and hides thin genres', () => {
    expect(groupByGenre(list).map((g) => [g.genre, g.titles.length])).toEqual([['Drama', 2]]);
    expect(groupByGenre(list, 1).map((g) => g.genre)).toEqual(['Drama', 'Acción', 'Comedia']);
  });
  it('ignores non-string genres', () => {
    expect(groupByGenre([t(1, { genres: [{ id: 1 } as unknown as string] })], 1)).toEqual([]);
  });
});

describe('toggleInList', () => {
  it('adds at the front, then removes', () => {
    const a = t(1), b = t(2);
    const added = toggleInList([a], b);
    expect(added.added).toBe(true);
    expect(added.list.map((x) => x.id)).toEqual([2, 1]);
    const removed = toggleInList(added.list, b);
    expect(removed.added).toBe(false);
    expect(removed.list.map((x) => x.id)).toEqual([1]);
  });
});

describe('firstFileId', () => {
  const seasons = [{ number: 1, episodes: [{ id: 10, number: 1 }, { id: 11, number: 2 }] }];
  it('prefers the first ready episode file, ignoring extras', () => {
    const files = [
      { id: 5, status: 'ready', episodeId: null, extraLabel: 'OP' },
      { id: 7, status: 'pending', episodeId: 10, extraLabel: null },
      { id: 8, status: 'ready', episodeId: 11, extraLabel: null },
    ];
    expect(firstFileId({ seasons, files })).toBe(8);
  });
  it('falls back to the first episode file, then to a movie file', () => {
    expect(firstFileId({ seasons, files: [{ id: 7, status: 'pending', episodeId: 10, extraLabel: null }] })).toBe(7);
    expect(firstFileId({ seasons: [], files: [{ id: 3, status: 'ready', episodeId: null, extraLabel: null }] })).toBe(3);
    expect(firstFileId({ seasons: [], files: [] })).toBeNull();
  });
});

describe('profile avatar', () => {
  it('honours a hex avatar and is stable otherwise', () => {
    expect(avatarColor({ id: 1, avatar: '#112233' })).toBe('#112233');
    expect(avatarColor({ id: 3, avatar: null })).toBe(avatarColor({ id: 3, avatar: null }));
    expect(avatarColor({ id: 3, avatar: null })).not.toBe(avatarColor({ id: 4, avatar: null }));
  });
  it('takes the first letter', () => {
    expect(initial('  daniel')).toBe('D');
    expect(initial('')).toBe('?');
  });
});
