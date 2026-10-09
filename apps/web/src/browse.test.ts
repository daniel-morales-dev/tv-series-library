import { describe, expect, it } from 'vitest';
import { facets, filtersToParams, filtersToQuery, isFiltered, matchesQuery, mergeSearch, parseFilters } from './browse.ts';
import type { TitleSummary } from './types.ts';

const t = (id: number, over: Partial<TitleSummary> = {}): TitleSummary => ({
  id, kind: 'anime', title: `T${id}`, originalTitle: null, overview: null, year: 2020, runtimeMin: null,
  rating: null, genres: [], posterPath: null, backdropPath: null, logoPath: null, ...over,
});

describe('parseFilters / filtersToQuery', () => {
  it('defaults when the query is empty', () => {
    expect(parseFilters({})).toEqual({ genre: null, year: null, sort: 'recent' });
  });
  it('reads valid values and ignores garbage', () => {
    expect(parseFilters({ genre: 'Drama', year: '2009', sort: 'title' })).toEqual({ genre: 'Drama', year: 2009, sort: 'title' });
    expect(parseFilters({ genre: ['a', 'b'], year: 'x', sort: 'nope' })).toEqual({ genre: null, year: null, sort: 'recent' });
  });
  it('omits defaults so URLs stay short, and round-trips', () => {
    expect(filtersToQuery({ genre: null, year: null, sort: 'recent' })).toEqual({});
    const f = { genre: 'Drama', year: 2009, sort: 'year' as const };
    expect(parseFilters(filtersToQuery(f))).toEqual(f);
  });
  it('builds API params with the kind and limit', () => {
    expect(filtersToParams('anime', { genre: 'Ciencia ficción', year: 2009, sort: 'title' })).toBe(
      'kind=anime&limit=200&sort=title&genre=Ciencia%20ficci%C3%B3n&year=2009',
    );
    expect(filtersToParams('movie', { genre: null, year: null, sort: 'recent' })).toBe('kind=movie&limit=200&sort=recent');
  });
  it('tells filtered from default', () => {
    expect(isFiltered({ genre: null, year: null, sort: 'title' })).toBe(false);
    expect(isFiltered({ genre: 'x', year: null, sort: 'recent' })).toBe(true);
  });
});

describe('facets', () => {
  it('lists distinct genres (es order) and years (newest first)', () => {
    const f = facets([t(1, { genres: ['Drama', 'Acción'], year: 2009 }), t(2, { genres: ['Drama'], year: 2015 }), t(3, { year: null })]);
    expect(f).toEqual({ genres: ['Acción', 'Drama'], years: [2015, 2009] });
  });
});

describe('matchesQuery', () => {
  it('ignores case and accents, checks both titles', () => {
    expect(matchesQuery(t(1, { title: 'Pokémon' }), 'pokemon')).toBe(true);
    expect(matchesQuery(t(1, { title: 'x', originalTitle: '化物語' }), '化物')).toBe(true);
    expect(matchesQuery(t(1, { title: 'Naruto' }), 'bleach')).toBe(false);
    expect(matchesQuery(t(1), '  ')).toBe(false);
  });
});

describe('mergeSearch', () => {
  const all = [t(1, { title: 'Alfa' }), t(2, { title: 'Beta' }), t(3, { title: 'Alfabeto' })];
  it('puts suggested titles first, then other text matches, without duplicates', () => {
    const r = mergeSearch(all, [{ type: 'title', id: 3 }, { type: 'person', id: 2 }, { type: 'title', id: 99 }], 'alfa');
    expect(r.map((x) => x.id)).toEqual([3, 1]);
  });
  it('is empty for no matches', () => expect(mergeSearch(all, [], 'zzz')).toEqual([]));
});
