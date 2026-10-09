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

export function buildEpisodes(d: TitleDetail): SeasonRows[] {
  return [...d.seasons]
    .sort((a, b) => a.number - b.number)
    .map((s) => ({
      id: s.id,
      number: s.number,
      name: s.name,
      rows: [...s.episodes]
        .sort((a, b) => a.number - b.number)
        .map((e) => {
          const file = d.files.find((f) => f.episodeId === e.id && !f.extraLabel) ?? null;
          return { ...e, season: s.number, file, progress: (file && d.progress?.find((p) => p.mediaFileId === file.id)) || null };
        }),
    }));
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
