export interface Genre {
  id: number;
  name: string;
}
export interface TmdbEpisode {
  episode_number?: number;
  name: string | null;
  overview: string | null;
  runtime: number | null;
  still_path: string | null;
  air_date: string | null;
}
export interface SeasonSummary {
  season_number: number;
  name: string;
  overview: string;
  poster_path: string | null;
  episode_count: number;
}
export interface SeasonDetails extends SeasonSummary {
  episodes: TmdbEpisode[];
}
export interface Credits {
  cast: { id: number; name: string; character: string | null; profile_path: string | null; order: number }[];
  crew: { id: number; name: string; job: string; profile_path: string | null }[];
}
interface Logos {
  logos?: { file_path: string; iso_639_1: string | null }[];
}
export interface EpisodeGroupRef {
  id: string;
  name: string;
  type: number;
  episode_count: number;
}
export interface TvSearchResult {
  id: number;
  name: string;
  original_name: string;
  first_air_date?: string | null;
  overview?: string | null;
}
export interface TvDetails extends TvSearchResult {
  overview: string | null;
  episode_run_time?: number[];
  vote_average: number | null;
  genres: Genre[];
  poster_path: string | null;
  backdrop_path: string | null;
  origin_country: string[];
  seasons: SeasonSummary[];
  credits?: Credits;
  alternative_titles?: { results: { title: string }[] };
  episode_groups?: { results: EpisodeGroupRef[] };
  images?: Logos;
}
export interface EpisodeSubGroup {
  id: string;
  name: string;
  order: number;
  episodes: TmdbEpisode[];
}
export interface EpisodeGroupDetails {
  id: string;
  name: string;
  type: number;
  groups: EpisodeSubGroup[];
}
export interface MovieSearchResult {
  id: number;
  title: string;
  original_title: string;
  release_date?: string | null;
  overview?: string | null;
}
export interface CollectionDetails {
  id: number;
  name: string;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
}
export interface MovieDetails extends MovieSearchResult {
  overview: string | null;
  runtime: number | null;
  vote_average: number | null;
  genres: Genre[];
  poster_path: string | null;
  backdrop_path: string | null;
  belongs_to_collection: { id: number; name: string; poster_path: string | null; backdrop_path: string | null } | null;
  credits?: Credits;
  images?: Logos;
}

export interface PersonNames {
  es: string | null;
  en: string | null;
}

export interface TmdbClient {
  searchTv(query: string): Promise<TvSearchResult[]>;
  tv(id: number): Promise<TvDetails>;
  /** null when TMDB has no such season. */
  tvSeason(id: number, season: number): Promise<SeasonDetails | null>;
  episodeGroup(id: string): Promise<EpisodeGroupDetails>;
  searchMovie(query: string, year?: number): Promise<MovieSearchResult[]>;
  movie(id: number): Promise<MovieDetails>;
  collection(id: number): Promise<CollectionDetails>;
  /** Translated display names of a person; null when TMDB has none for that language. */
  personNames(id: number): Promise<PersonNames>;
  /** null when the image does not exist (404). */
  image(size: string, path: string): Promise<Uint8Array | null>;
}

export class TmdbHttpError extends Error {
  status: number;
  constructor(status: number, what: string) {
    super(`TMDB ${status} on ${what}`);
    this.status = status;
  }
}

const API = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p';
const TIMEOUT_MS = 20_000;
const MAX_RETRIES_429 = 3;
const MAX_BACKOFF_MS = 10_000;
const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createTmdbClient(token: string, fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = sleepMs): TmdbClient {
  const request = async (url: string, what: string, headers: Record<string, string> = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      if (res.status !== 429 || attempt >= MAX_RETRIES_429) throw new TmdbHttpError(res.status, what);
      // Honour Retry-After; otherwise 1 s, 2 s, 4 s.
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
      await sleep(Math.min(wait, MAX_BACKOFF_MS));
    }
  };
  const api = async <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(API + path);
    url.searchParams.set('language', 'es-MX');
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await request(url.toString(), path, { Authorization: `Bearer ${token}`, accept: 'application/json' });
    return (await res.json()) as T;
  };
  const orNull = async <T>(p: Promise<T>): Promise<T | null> =>
    p.catch((err) => {
      if (err instanceof TmdbHttpError && err.status === 404) return null;
      throw err;
    });

  return {
    searchTv: async (query) => (await api<{ results: TvSearchResult[] }>('/search/tv', { query })).results,
    tv: (id) =>
      api(`/tv/${id}`, {
        append_to_response: 'credits,alternative_titles,episode_groups,images',
        include_image_language: 'es,en,null',
      }),
    tvSeason: (id, season) => orNull(api(`/tv/${id}/season/${season}`)),
    episodeGroup: (id) => api(`/tv/episode_group/${id}`),
    searchMovie: async (query, year) =>
      (await api<{ results: MovieSearchResult[] }>('/search/movie', { query, year })).results,
    movie: (id) => api(`/movie/${id}`, { append_to_response: 'credits,images', include_image_language: 'es,en,null' }),
    collection: (id) => api(`/collection/${id}`),
    personNames: async (id) => {
      const res = await orNull(
        api<{ translations: { iso_639_1: string; data: { name?: string } }[] }>(`/person/${id}/translations`),
      );
      const pick = (lang: string) => res?.translations.find((t) => t.iso_639_1 === lang && t.data.name?.trim())?.data.name?.trim() ?? null;
      return { es: pick('es'), en: pick('en') };
    },
    image: async (size, path) => {
      const res = await orNull(request(`${IMAGES}/${size}${path}`, 'image'));
      return res ? new Uint8Array(await res.arrayBuffer()) : null;
    },
  };
}

// Lookups outlive a scan: a rescan, a second folder of the same title or a confirmation reuses every success.
// Searches are the only answers that go stale (a title may be added to TMDB later), so they expire. After a failure
// the client stays quiet for a growing wait instead of being asked again on every scan; cached answers still work.
const SEARCH_TTL_MS = 6 * 3_600_000;
const EMPTY_SEARCH_TTL_MS = 15 * 60_000;
const FAIL_WAIT_MS = 60_000;
const MAX_FAIL_WAIT_MS = 30 * 60_000;
const MAX_ENTRIES = 300;

interface Shared {
  entries: Map<string, { value: Promise<unknown>; expires: number }>;
  empties: Map<string, number>;
  failures: number;
  until: number;
  error: Error | null;
}
const shared = new WeakMap<TmdbClient, Shared>();

export function memoize(client: TmdbClient, now: () => number = Date.now): TmdbClient {
  const s: Shared = shared.get(client) ?? { entries: new Map(), empties: new Map(), failures: 0, until: 0, error: null };
  shared.set(client, s);

  const guarded = async <R>(call: () => Promise<R>): Promise<R> => {
    if (now() < s.until) throw s.error!;
    try {
      const value = await call();
      s.failures = 0;
      return value;
    } catch (err) {
      if (now() >= s.until) {
        s.failures++;
        s.until = now() + Math.min(FAIL_WAIT_MS * 2 ** (s.failures - 1), MAX_FAIL_WAIT_MS);
        s.error = err as Error;
      }
      throw err;
    }
  };

  const once =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>, isSearch = false) =>
    (...args: A): Promise<R> => {
      const key = `${name}:${JSON.stringify(args)}`;
      const hit = s.entries.get(key);
      if (hit && hit.expires > now()) return hit.value as Promise<R>;
      const entry = { value: guarded(() => fn(...args)), expires: Infinity };
      s.entries.set(key, entry);
      if (s.entries.size > MAX_ENTRIES) s.entries.delete(s.entries.keys().next().value!);
      entry.value.then(
        (result) => {
          if (!isSearch) return;
          const empty = Array.isArray(result) && result.length === 0;
          const n = empty ? (s.empties.get(key) ?? 0) + 1 : 0;
          s.empties.set(key, n);
          entry.expires = now() + (empty ? Math.min(EMPTY_SEARCH_TTL_MS * 2 ** (n - 1), SEARCH_TTL_MS) : SEARCH_TTL_MS);
        },
        () => {
          if (s.entries.get(key) === entry) s.entries.delete(key);
        },
      );
      return entry.value as Promise<R>;
    };
  return {
    searchTv: once('searchTv', client.searchTv, true),
    tv: once('tv', client.tv),
    tvSeason: once('tvSeason', client.tvSeason),
    episodeGroup: once('episodeGroup', client.episodeGroup),
    searchMovie: once('searchMovie', client.searchMovie, true),
    movie: once('movie', client.movie),
    collection: once('collection', client.collection),
    personNames: once('personNames', client.personNames),
    image: (size, path) => guarded(() => client.image(size, path)),
  };
}

// Used when no token is configured: every call fails, so ingestion runs in offline mode.
export function unavailableTmdb(): TmdbClient {
  const fail = () => Promise.reject(new Error('TMDB_READ_ACCESS_TOKEN is not set'));
  return { searchTv: fail, tv: fail, tvSeason: fail, episodeGroup: fail, searchMovie: fail, movie: fail, collection: fail, personNames: fail, image: fail };
}
