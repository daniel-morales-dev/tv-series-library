import type { Credit, Episode, MediaFile, TitleDetail, WatchProgress } from './types.ts';

export interface EpisodeRow extends Episode {
  season: number;
  file: MediaFile | null;
  progress: WatchProgress | null;
}
export interface SeasonRows {
  id: number;
  number: number;
  name: string | null;
  rows: EpisodeRow[];
}

/** The file fields the play order reads; a full `MediaFile` also fits. */
interface PlayableFile {
  id: number;
  status: string;
  episodeId: number | null;
  extraLabel: string | null;
}

/**
 * The single play order: seasons by air date (undated last), then number, episodes by number, newest
 * non-extra file per episode (`null` when the episode has none). `buildEpisodes` and `firstFileId` both build on it.
 */
export function orderedSeasons<S extends { number: number; airDate?: string | null; episodes: { id: number; number: number }[] }, F extends PlayableFile>(
  d: { seasons: S[]; files: F[] },
): { season: S; rows: { episode: S['episodes'][number]; file: F | null }[] }[] {
  return [...d.seasons]
    .sort((a, b) => (a.airDate ?? '9999').localeCompare(b.airDate ?? '9999') || a.number - b.number)
    .map((season) => ({
      season,
      rows: [...season.episodes]
        .sort((a, b) => a.number - b.number)
        // Newest playable row wins: a stale re-ingest must not shadow the current file.
        .map((episode) => ({ episode, file: pickFile(d.files.filter((f) => f.episodeId === episode.id && !f.extraLabel)) })),
    }));
}

export function buildEpisodes(d: TitleDetail): SeasonRows[] {
  return orderedSeasons(d).map(({ season, rows }) => ({
    id: season.id,
    number: season.number,
    name: season.name,
    rows: rows.map(({ episode, file }) => ({
      ...episode,
      season: season.number,
      file,
      progress: (file && d.progress?.find((p) => p.mediaFileId === file.id)) || null,
    })),
  }));
}

/** Every episode of the season that has a file is completed (episodes without a file cannot be marked). */
export function seasonFinished(s: SeasonRows): boolean {
  const withFile = s.rows.filter((r) => r.file);
  return withFile.length > 0 && withFile.every((r) => r.progress?.completed);
}

export const episodeSeen = (row: Pick<EpisodeRow, 'progress'>): boolean => !!row.progress?.completed;

/** The seen/unseen toggle of one episode: `null` when it has no file to mark. */
export function seenToggle(row: Pick<EpisodeRow, 'progress' | 'file'>): { fileId: number; finished: boolean; label: string } | null {
  if (!row.file) return null;
  const seen = episodeSeen(row);
  return { fileId: row.file.id, finished: !seen, label: seen ? 'Marcar como no visto' : 'Marcar como visto' };
}

/**
 * Newest live row for one episode: highest `id` among rows not `downloading`.
 * If every match is downloading, the highest `id` among them; `null` when empty.
 */
export function pickFile<T extends { id: number; status: string }>(matches: T[]): T | null {
  const live = matches.filter((f) => f.status !== 'downloading');
  const pool = live.length ? live : matches;
  if (!pool.length) return null;
  return pool.reduce((best, f) => (f.id > best.id ? f : best));
}

/** A downloading file has no video yet; the server answers 409 if it is played. */
export const isPlayable = (f: MediaFile | null): f is MediaFile => !!f && f.status !== 'downloading';

export type PlayAction = 'play' | 'resume' | 'rewatch';
export const ACTION_LABEL: Record<PlayAction, string> = { play: 'Reproducir', resume: 'Continuar', rewatch: 'Ver de nuevo' };

export function progressAction(p: WatchProgress | null | undefined): PlayAction {
  if (!p) return 'play';
  if (p.completed) return 'rewatch';
  return p.positionS >= 10 ? 'resume' : 'play';
}
export const episodeAction = (row: Pick<EpisodeRow, 'progress'>): PlayAction => progressAction(row.progress);

export interface PlayPlan {
  fileId: number;
  action: PlayAction;
  /** Button text, e.g. `Continuar T1·E3`. */
  label: string;
}

/** What the title's main button does: first unfinished episode, or the first one again when all are done. */
export function playPlan(d: TitleDetail): PlayPlan | null {
  if (d.comingSoon) return null;
  const rows = buildEpisodes(d).flatMap((s) => s.rows).filter((r) => isPlayable(r.file));
  if (!rows.length) {
    const f = d.files.find((x) => !x.extraLabel && x.episodeId === null && isPlayable(x));
    if (!f) return null;
    const action = progressAction(d.progress?.find((p) => p.mediaFileId === f.id));
    return { fileId: f.id, action, label: action === 'resume' ? 'Continuar' : ACTION_LABEL[action] };
  }
  const i = rows.findIndex((r) => !r.progress?.completed);
  if (i < 0) return { fileId: rows[0]!.file!.id, action: 'rewatch', label: ACTION_LABEL.rewatch };
  const r = rows[i]!;
  const started = i > 0 || progressAction(r.progress) === 'resume';
  return started
    ? { fileId: r.file!.id, action: 'resume', label: `Continuar T${r.season}·E${r.number}` }
    : { fileId: r.file!.id, action: 'play', label: ACTION_LABEL.play };
}

export function runtimeLabel(runtimeMin: number | null, durationS: number | null): string | null {
  const min = runtimeMin ?? (durationS ? Math.round(durationS / 60) : null);
  if (!min) return null;
  return min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
}

const dateFmt = new Intl.DateTimeFormat('es', { dateStyle: 'long', timeZone: 'UTC' });
export function airDateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : dateFmt.format(t);
}

export const castOf = (credits: Credit[], max = 16): Credit[] => credits.filter((c) => c.role === 'cast').slice(0, max);
