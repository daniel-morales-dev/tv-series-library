import { languageName } from './languages.ts';
import { pickFile } from './titlePage.ts';
import type { SubtitleTrack, TitleDetail, WatchProgress } from './types.ts';

/** Seconds to start from: the saved spot unless finished or barely started. */
export function resumePosition(progress: WatchProgress[] | undefined, fileId: number): number {
  const p = progress?.find((x) => x.mediaFileId === fileId);
  return !p || p.completed || p.positionS < 10 ? 0 : p.positionS;
}

/** Index in `tracks` of the first supported Spanish subtitle, or -1 for none. */
export function defaultSubtitle(tracks: SubtitleTrack[]): number {
  return tracks.findIndex((t) => t.supported && /^(es|spa)/i.test(t.language ?? ''));
}

/** "Inglés", or "Inglés · Forced" when the track title says more than the language itself. */
export function subtitleLabel(t: SubtitleTrack, i: number): string {
  const lang = languageName(t.language);
  if (lang === 'Desconocido') return t.title || `Subtítulo ${i + 1}`;
  const plain = [lang, t.language, new Intl.DisplayNames(['en'], { type: 'language' }).of(t.language!)].map((x) => x?.toLowerCase());
  return t.title && !plain.includes(t.title.toLowerCase()) ? `${lang} · ${t.title}` : lang;
}

interface EpisodeFile {
  episodeId: number;
  fileId: number;
  name: string;
}

/** Playable rows in season → episode order; the newest live file per episode wins, extras don't count. */
function orderedFiles(detail: TitleDetail): EpisodeFile[] {
  return [...detail.seasons]
    .sort((a, b) => a.number - b.number)
    .flatMap((s) => [...s.episodes].sort((a, b) => a.number - b.number))
    .flatMap((e) => {
      const f = pickFile(detail.files.filter((x) => x.episodeId === e.id && !x.extraLabel));
      return f ? [{ episodeId: e.id, fileId: f.id, name: e.name || `Episodio ${e.number}` }] : [];
    });
}

/** Index of the playing row in `ordered`; a stale duplicate must not hide its episode, so match the episode too. */
function playingIndex(detail: TitleDetail, ordered: EpisodeFile[], fileId: number): number {
  const current = detail.files.find((f) => f.id === fileId);
  return ordered.findIndex((x) => x.fileId === fileId || x.episodeId === current?.episodeId);
}

/** Next episode with a file, in season → episode order. */
export function nextFile(detail: TitleDetail, fileId: number): { fileId: number; name: string } | null {
  const ordered = orderedFiles(detail);
  const i = playingIndex(detail, ordered, fileId);
  const next = i >= 0 ? ordered[i + 1] : undefined;
  return next ? { fileId: next.fileId, name: next.name } : null;
}

/** Previous episode with a file, in season → episode order. Mirrors `nextFile`. */
export function prevFile(detail: TitleDetail, fileId: number): { fileId: number; name: string } | null {
  const ordered = orderedFiles(detail);
  const i = playingIndex(detail, ordered, fileId);
  const prev = i > 0 ? ordered[i - 1] : undefined;
  return prev ? { fileId: prev.fileId, name: prev.name } : null;
}

/** One row of the player's audio menu; `id` is the hls.js track index used by `pickAudio`. */
export function audioMenu(tracks: readonly { lang?: string | null; name?: string | null }[]): { id: number; name: string }[] {
  return tracks.map((t, i) => ({ id: i, name: t.lang ? languageName(t.lang) : t.name || `Audio ${i + 1}` }));
}

/** Track to keep selected when the audio list (re)loads: the active one, else the previous pick, else the first. */
export function audioSelection(length: number, active: number, previous: number): number {
  if (active >= 0 && active < length) return active;
  if (previous >= 0 && previous < length) return previous;
  return 0;
}

/** "12:34", or "1:02:03" past an hour; "--:--" when the value is not a usable time. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Slider bounds for the progress row; null while the duration is unusable (live/EVENT playlist edge states). */
export function seekRange(current: number, duration: number): { max: number; value: number } | null {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const value = Number.isFinite(current) ? Math.min(Math.max(current, 0), duration) : 0;
  return { max: duration, value };
}
