import type { TitleSummary } from './types.ts';

export type Sort = 'recent' | 'title' | 'year';
export interface Filters {
  genre: string | null;
  year: number | null;
  sort: Sort;
}

export const SORT_LABEL: Record<Sort, string> = { recent: 'Recientes', title: 'Título', year: 'Año' };
const SORTS = Object.keys(SORT_LABEL) as Sort[];

const one = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** URL query → filters. Anything unknown or malformed falls back to the default. */
export function parseFilters(query: Record<string, unknown>): Filters {
  const year = Number(one(query.year));
  const sort = one(query.sort);
  return {
    genre: one(query.genre),
    year: Number.isInteger(year) && year > 0 ? year : null,
    sort: SORTS.find((s) => s === sort) ?? 'recent',
  };
}

/** Filters → URL query, leaving defaults out so plain pages keep a clean URL. */
export function filtersToQuery(f: Filters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.genre) q.genre = f.genre;
  if (f.year) q.year = String(f.year);
  if (f.sort !== 'recent') q.sort = f.sort;
  return q;
}

export const isFiltered = (f: Filters): boolean => f.genre !== null || f.year !== null;

/** `GET /api/titles` query string (the server caps `limit` at 200). */
export function filtersToParams(kind: TitleSummary['kind'], f: Filters): string {
  const p = new URLSearchParams({ kind, limit: '200', sort: f.sort });
  if (f.genre) p.set('genre', f.genre);
  if (f.year) p.set('year', String(f.year));
  return p.toString().replaceAll('+', '%20');
}

/** Options for the filter bar: only what the library actually has. */
export function facets(titles: TitleSummary[]): { genres: string[]; years: number[] } {
  const genres = new Set<string>();
  const years = new Set<number>();
  for (const t of titles) {
    for (const g of t.genres) if (typeof g === 'string') genres.add(g);
    if (t.year) years.add(t.year);
  }
  return { genres: [...genres].sort((a, b) => a.localeCompare(b, 'es')), years: [...years].sort((a, b) => b - a) };
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Case- and accent-insensitive substring match on the title and its original title. */
export function matchesQuery(t: TitleSummary, q: string): boolean {
  const needle = fold(q.trim());
  return needle !== '' && fold(`${t.title} ${t.originalTitle ?? ''}`).includes(needle);
}

/** Search hits: title suggestions first (server relevance order), then any other title containing the text. */
export function mergeSearch(all: TitleSummary[], suggestions: { type: string; id: number }[], q: string): TitleSummary[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const ranked = suggestions.filter((s) => s.type === 'title').flatMap((s) => byId.get(s.id) ?? []);
  const seen = new Set(ranked.map((t) => t.id));
  return [...ranked, ...all.filter((t) => !seen.has(t.id) && matchesQuery(t, q))];
}
