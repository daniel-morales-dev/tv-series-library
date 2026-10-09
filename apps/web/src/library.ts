import type { ContinueItem, Profile, TitleSummary } from './types.ts';

export const KIND_BY_SLUG = { series: 'series', movies: 'movie', anime: 'anime' } as const;
export type KindSlug = keyof typeof KIND_BY_SLUG;

export function remainingMinutes(positionS: number, durationS: number | null): number | null {
  if (!durationS) return null;
  return Math.max(0, Math.ceil((durationS - positionS) / 60));
}

export function remainingLabel(positionS: number, durationS: number | null): string | null {
  const m = remainingMinutes(positionS, durationS);
  if (m === null) return null;
  if (m === 1) return '1m restante';
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m restantes`;
  return `${m}m restantes`;
}

export function progressPct(positionS: number, durationS: number | null): number {
  if (!durationS) return 0;
  return Math.min(100, Math.max(0, (positionS / durationS) * 100));
}

export function episodeLabel(season: number | null, episode: number | null, name: string | null): string {
  if (season === null || episode === null) return '';
  return `T${season} · E${episode}${name ? ` — ${name}` : ''}`;
}

export interface HeroPick {
  title: TitleSummary;
  resume: ContinueItem | null;
}

export function pickHeroes(titles: TitleSummary[], cont: ContinueItem[], max = 5): HeroPick[] {
  const picks = new Map<number, HeroPick>();
  for (const c of cont) if (c.title.backdropPath) picks.set(c.title.id, { title: c.title, resume: c });
  for (const t of titles) if (t.backdropPath && !picks.has(t.id)) picks.set(t.id, { title: t, resume: null });
  return [...picks.values()].slice(0, max);
}

export interface GenreRow {
  genre: string;
  titles: TitleSummary[];
}

/** One row per genre, biggest first. A genre needs `minTitles` titles so a tiny library doesn't repeat itself. */
export function groupByGenre(titles: TitleSummary[], minTitles = 2): GenreRow[] {
  const by = new Map<string, TitleSummary[]>();
  for (const t of titles) {
    for (const g of t.genres) if (typeof g === 'string') (by.get(g) ?? by.set(g, []).get(g)!).push(t);
  }
  return [...by.entries()]
    .filter(([, list]) => list.length >= minTitles)
    .map(([genre, list]) => ({ genre, titles: list }))
    .sort((a, b) => b.titles.length - a.titles.length || a.genre.localeCompare(b.genre, 'es'));
}

export function toggleInList(list: TitleSummary[], title: TitleSummary): { list: TitleSummary[]; added: boolean } {
  return list.some((t) => t.id === title.id)
    ? { list: list.filter((t) => t.id !== title.id), added: false }
    : { list: [title, ...list], added: true };
}

interface PlayableDetail {
  seasons: { number: number; episodes: { id: number; number: number }[] }[];
  files: { id: number; status: string; episodeId: number | null; extraLabel: string | null }[];
}

/** File to start a title from: first ready episode (or movie file); otherwise the first file of any state. */
export function firstFileId(d: PlayableDetail): number | null {
  const main = d.files.filter((f) => !f.extraLabel);
  const ordered = d.seasons
    .flatMap((s) => [...s.episodes].sort((a, b) => a.number - b.number))
    .flatMap((e) => main.filter((f) => f.episodeId === e.id));
  const candidates = ordered.length ? ordered : main.filter((f) => f.episodeId === null);
  return (candidates.find((f) => f.status === 'ready') ?? candidates[0])?.id ?? null;
}

export function avatarColor(p: Pick<Profile, 'id' | 'avatar'>): string {
  if (p.avatar && /^#[0-9a-f]{6}$/i.test(p.avatar)) return p.avatar;
  return `hsl(${(p.id * 67) % 360} 52% 42%)`;
}

export function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

export const KIND_LABEL: Record<TitleSummary['kind'], string> = { movie: 'Película', series: 'Serie', anime: 'Anime' };
