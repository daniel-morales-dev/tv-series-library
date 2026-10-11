import type {
  EpisodeGroupDetails,
  MovieDetails,
  SeasonDetails,
  TmdbClient,
  TmdbEpisode,
  TvDetails,
} from '../src/modules/ingest/tmdb.ts';

const ep = (n: number, name = `Episodio ${n}`): TmdbEpisode => ({
  episode_number: n,
  name,
  overview: `Resumen ${n}`,
  runtime: 24,
  still_path: `/still${n}.jpg`,
  air_date: '2009-07-03',
});
const eps = (count: number) => Array.from({ length: count }, (_, i) => ep(i + 1));
const season = (number: number, count: number) => ({
  season_number: number,
  name: `Temporada ${number}`,
  overview: '',
  poster_path: null,
  episode_count: count,
});
const credits = {
  cast: [{ id: 1, name: 'Hiroshi Kamiya', character: 'Araragi', profile_path: '/kamiya.jpg', order: 0 }],
  crew: [{ id: 2, name: 'Akiyuki Shinbo', job: 'Director', profile_path: null }],
};

const monogatari: TvDetails = {
  id: 46195,
  name: 'Monogatari',
  original_name: '物語シリーズ',
  overview: 'Serie de novelas ligeras.',
  first_air_date: '2009-07-03',
  episode_run_time: [24],
  vote_average: 8.4,
  genres: [{ id: 16, name: 'Animación' }],
  poster_path: '/mono.jpg',
  backdrop_path: '/mono-bd.jpg',
  origin_country: ['JP'],
  seasons: [season(0, 6), season(1, 15)],
  credits,
  alternative_titles: { results: [{ title: 'Monogatari Series' }] },
  episode_groups: {
    results: [
      { id: 'g_dvd', name: 'DVD', type: 3, episode_count: 12 },
      { id: 'g_air', name: 'Original air date', type: 1, episode_count: 26 },
      { id: 'g_mono_seasons', name: 'Seasons', type: 6, episode_count: 30 },
    ],
  },
  images: { logos: [{ file_path: '/mono-logo.png', iso_639_1: 'en' }] },
};

const groups: Record<string, EpisodeGroupDetails> = {
  g_air: {
    id: 'g_air',
    name: 'Original air date',
    type: 1,
    groups: [
      {
        id: 'a1',
        name: 'Bakemonogatari',
        order: 1,
        episodes: [...eps(12), ep(13, 'Tsubasa Cat 3'), ep(14, 'Tsubasa Cat 4'), ep(15, 'Tsubasa Cat 5')],
      },
      { id: 'a2', name: 'Nisemonogatari', order: 2, episodes: eps(11) },
    ],
  },
  g_mono_seasons: {
    id: 'g_mono_seasons',
    name: 'Seasons',
    type: 6,
    groups: [
      { id: 'm1', name: 'Season 1', order: 1, episodes: eps(12) },
      { id: 'm2', name: 'Season 2', order: 2, episodes: eps(11) },
    ],
  },
  g_s_arcs: {
    id: 'g_s_arcs',
    name: 'Arcs',
    type: 5,
    groups: [{ id: 'x1', name: 'Arc one', order: 1, episodes: eps(38) }],
  },
  g_s_seasons: {
    id: 'g_s_seasons',
    name: 'Seasons',
    type: 6,
    groups: [
      { id: 's1', name: 'Season 1', order: 1, episodes: eps(28) },
      { id: 's0', name: 'Specials', order: 0, episodes: eps(3) },
      { id: 's2', name: 'Season 2', order: 2, episodes: eps(10) },
    ],
  },
  g_c_seasons: {
    id: 'g_c_seasons',
    name: 'Seasons',
    type: 6,
    groups: [
      { id: 'c1', name: 'Season 1', order: 1, episodes: eps(3) },
      { id: 'c2', name: 'Season 2', order: 2, episodes: eps(2) },
    ],
  },
  g_dvd: {
    id: 'g_dvd',
    name: 'DVD',
    type: 3,
    groups: [{ id: 'd1', name: 'Bakemonogatari', order: 1, episodes: eps(12) }],
  },
};

// Official TMDB has a single 38-episode season; the type 6 group splits it 28 + 10 (like Frieren).
const seasoned: TvDetails = {
  ...monogatari,
  id: 200,
  name: 'Seasoned Show',
  original_name: 'Seasoned Show',
  alternative_titles: undefined,
  origin_country: ['US'],
  seasons: [season(0, 3), season(1, 38)],
  episode_groups: {
    results: [
      { id: 'g_s_arcs', name: 'Arcs', type: 5, episode_count: 38 },
      { id: 'g_s_seasons', name: 'Seasons', type: 6, episode_count: 41 },
    ],
  },
};
const sameCount: TvDetails = {
  ...seasoned,
  id: 201,
  name: 'Same Count',
  original_name: 'Same Count',
  // Six official episodes against the group's five: still not enough to replace the official seasons (T73).
  seasons: [season(1, 3), season(2, 3)],
  episode_groups: { results: [{ id: 'g_c_seasons', name: 'Seasons', type: 6, episode_count: 5 }] },
};
const tvById: Record<number, TvDetails> = { 46195: monogatari, 200: seasoned, 201: sameCount };

const plain: TvDetails = {
  id: 100,
  name: 'Plain Show',
  original_name: 'Plain Show',
  overview: 'Una serie normal.',
  first_air_date: '2015-01-01',
  episode_run_time: [45],
  vote_average: 7,
  genres: [{ id: 18, name: 'Drama' }],
  poster_path: null,
  backdrop_path: null,
  origin_country: ['US'],
  seasons: [season(0, 1), season(1, 3), season(2, 2)],
};
const seasonedOfficial: Record<number, SeasonDetails> = {
  0: { ...season(0, 3), episodes: eps(3) },
  1: { ...season(1, 38), episodes: eps(38) },
};
const plainSeasons: Record<number, SeasonDetails> = {
  1: { ...season(1, 3), episodes: eps(3) },
  2: { ...season(2, 2), episodes: eps(2) },
};

const inception: MovieDetails = {
  id: 27205,
  title: 'Origen',
  original_title: 'Inception',
  overview: 'Sueños dentro de sueños.',
  release_date: '2010-07-16',
  runtime: 148,
  vote_average: 8.3,
  genres: [{ id: 878, name: 'Ciencia ficción' }],
  poster_path: '/inception.jpg',
  backdrop_path: '/inception-bd.jpg',
  belongs_to_collection: { id: 555, name: 'Saga Origen', poster_path: '/saga.jpg', backdrop_path: null },
  credits,
  images: { logos: [] },
};

export type FakeTmdb = TmdbClient & { calls: string[] };

export function makeFakeTmdb({
  offline = false,
  people = {},
}: { offline?: boolean; people?: Record<number, { es?: string | null; en?: string | null }> } = {}): FakeTmdb {
  const calls: string[] = [];
  const hit = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    return offline ? Promise.reject(new Error('network down')) : Promise.resolve(value);
  };
  return {
    calls,
    searchTv: (q) => {
      const n = q.toLowerCase();
      if (n.includes('bakemonogatari') || n.includes('nisemonogatari'))
        return hit(`searchTv:${q}`, [{ id: 46195, name: 'Monogatari', original_name: '物語シリーズ', first_air_date: '2009-07-03' }]);
      if (n.includes('seasoned')) return hit(`searchTv:${q}`, [{ id: 200, name: 'Seasoned Show', original_name: 'Seasoned Show' }]);
      if (n.includes('same count')) return hit(`searchTv:${q}`, [{ id: 201, name: 'Same Count', original_name: 'Same Count' }]);
      if (n.includes('plain show')) return hit(`searchTv:${q}`, [{ id: 100, name: 'Plain Show', original_name: 'Plain Show', first_air_date: '2015-01-01' }]);
      if (n.includes('zzz'))
        return hit(`searchTv:${q}`, [
          { id: 100, name: 'Plain Show', original_name: 'Plain Show' },
          { id: 46195, name: 'Monogatari', original_name: '物語シリーズ' },
        ]);
      return hit(`searchTv:${q}`, []);
    },
    tv: (id) => hit(`tv:${id}`, tvById[id] ?? plain),
    tvSeason: (id, n) => hit(`season:${n}`, (id === 200 ? seasonedOfficial : plainSeasons)[n] ?? null),
    episodeGroup: (id) => hit(`group:${id}`, groups[id]!),
    searchMovie: (q, year) =>
      hit(
        `searchMovie:${q}:${year ?? ''}`,
        q.toLowerCase().startsWith('inception')
          ? [{ id: 27205, title: 'Origen', original_title: 'Inception', release_date: '2010-07-16' }]
          : [],
      ),
    movie: () => hit('movie', inception),
    collection: () => hit('collection', { id: 555, name: 'Saga Origen', overview: 'Todas las películas.', poster_path: '/saga.jpg', backdrop_path: null }),
    personNames: (id) => hit(`person:${id}`, { es: people[id]?.es ?? null, en: people[id]?.en ?? null }),
    image: (size, path) => hit(`image:${size}${path}`, path === '/still13.jpg' ? null : new Uint8Array([1, 2, 3])),
  };
}
