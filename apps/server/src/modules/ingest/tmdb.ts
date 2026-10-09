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

export interface TmdbClient {
  searchTv(query: string): Promise<TvSearchResult[]>;
  tv(id: number): Promise<TvDetails>;
  /** null when TMDB has no such season. */
  tvSeason(id: number, season: number): Promise<SeasonDetails | null>;
  episodeGroup(id: string): Promise<EpisodeGroupDetails>;
  searchMovie(query: string, year?: number): Promise<MovieSearchResult[]>;
  movie(id: number): Promise<MovieDetails>;
  collection(id: number): Promise<CollectionDetails>;
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

export function createTmdbClient(token: string, fetchImpl: typeof fetch = fetch): TmdbClient {
  const request = async (url: string, what: string, headers: Record<string, string> = {}) => {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new TmdbHttpError(res.status, what);
    return res;
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
    image: async (size, path) => {
      const res = await orNull(request(`${IMAGES}/${size}${path}`, 'image'));
      return res ? new Uint8Array(await res.arrayBuffer()) : null;
    },
  };
}

// One scan reuses every response; failures are not cached.
export function memoize(client: TmdbClient): TmdbClient {
  const cache = new Map<string, Promise<unknown>>();
  const once =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const key = `${name}:${JSON.stringify(args)}`;
      let hit = cache.get(key) as Promise<R> | undefined;
      if (!hit) {
        hit = fn(...args);
        cache.set(key, hit);
        hit.catch(() => cache.delete(key));
      }
      return hit;
    };
  return {
    searchTv: once('searchTv', client.searchTv),
    tv: once('tv', client.tv),
    tvSeason: once('tvSeason', client.tvSeason),
    episodeGroup: once('episodeGroup', client.episodeGroup),
    searchMovie: once('searchMovie', client.searchMovie),
    movie: once('movie', client.movie),
    collection: once('collection', client.collection),
    image: client.image,
  };
}

// Used when no token is configured: every call fails, so ingestion runs in offline mode.
export function unavailableTmdb(): TmdbClient {
  const fail = () => Promise.reject(new Error('TMDB_READ_ACCESS_TOKEN is not set'));
  return { searchTv: fail, tv: fail, tvSeason: fail, episodeGroup: fail, searchMovie: fail, movie: fail, collection: fail, image: fail };
}
