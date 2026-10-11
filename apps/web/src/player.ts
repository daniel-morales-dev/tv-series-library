import { streamUrl } from './api.ts';
import { languageName } from './languages.ts';
import { buildEpisodes } from './titlePage.ts';
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

/** T80: one selectable subtitle row; `ass` renders with libass (JASSUB), `vtt` with the native track element. */
export interface SubtitleChoice {
  /** Index into the track list handed to `subtitleChoices`. */
  track: number;
  mode: 'ass' | 'vtt';
}

/** Menu rows per track: the ASS original when the package carries one, plus the simple copy when both exist. */
export function subtitleChoices(tracks: SubtitleTrack[], assOk = true): SubtitleChoice[] {
  return tracks.flatMap((t, track) => [
    ...(assOk && t.ass ? [{ track, mode: 'ass' as const }] : []),
    ...(t.vtt ? [{ track, mode: 'vtt' as const }] : []),
  ]);
}

/** Index in `choices` of the default track (first Spanish), its ASS row when that track has one. */
export function defaultSubtitleChoice(choices: SubtitleChoice[], tracks: SubtitleTrack[]): number {
  const track = defaultSubtitle(tracks);
  return track < 0 ? -1 : choices.findIndex((c) => c.track === track);
}

/** "Español · Original (ASS)" / "Español · Simple" when the track offers both; the plain label otherwise. */
export function subtitleChoiceLabel(choice: SubtitleChoice, tracks: SubtitleTrack[]): string {
  const track = tracks[choice.track];
  if (!track) return '';
  const label = subtitleLabel(track, choice.track);
  if (!track.ass || !track.vtt) return label;
  return `${label} · ${choice.mode === 'ass' ? 'Original (ASS)' : 'Simple'}`;
}

/** T80: font names a package really serves — a plain file name with a font extension, nothing path-like. */
export function parseFontList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string' && /^[\w.-]+\.(ttf|otf|ttc|woff2?)$/i.test(n)) : [];
}

/** T80: the URLs JASSUB fetches the package fonts from. */
export function fontUrls(mediaFileId: number, names: string[]): string[] {
  return names.map((name) => streamUrl(mediaFileId, `fonts/${name}`));
}

interface EpisodeFile {
  episodeId: number;
  fileId: number;
  name: string;
}

/** Playable rows in season → episode order; the newest live file per episode wins, extras don't count. */
function orderedFiles(detail: TitleDetail): EpisodeFile[] {
  return buildEpisodes(detail)
    .flatMap((s) => s.rows)
    .flatMap((r) => (r.file ? [{ episodeId: r.id, fileId: r.file.id, name: r.name || `Episodio ${r.number}` }] : []));
}

/** Index of the playing row in `ordered`; a stale duplicate must not hide its episode, so match the episode too. */
function playingIndex(detail: TitleDetail, ordered: EpisodeFile[], fileId: number): number {
  const current = detail.files.find((f) => f.id === fileId);
  return ordered.findIndex((x) => x.fileId === fileId || x.episodeId === current?.episodeId);
}

/** The episode `delta` rows away in season → episode order: 1 is next, -1 is previous. */
export function neighborFile(detail: TitleDetail, fileId: number, delta: 1 | -1): { fileId: number; name: string } | null {
  const ordered = orderedFiles(detail);
  const i = playingIndex(detail, ordered, fileId);
  const row = i >= 0 ? ordered[i + delta] : undefined;
  return row ? { fileId: row.fileId, name: row.name } : null;
}

/** Next episode with a file, in season → episode order. */
export const nextFile = (detail: TitleDetail, fileId: number): { fileId: number; name: string } | null => neighborFile(detail, fileId, 1);

/** Previous episode with a file, in season → episode order. */
export const prevFile = (detail: TitleDetail, fileId: number): { fileId: number; name: string } | null => neighborFile(detail, fileId, -1);

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

/** Whether the idle timer may hide the chrome: focus inside it blocks the fade only for a keyboard/remote user. */
export function idleAllowed(modality: 'pointer' | 'keyboard', chromeFocused: boolean): boolean {
  return !chromeFocused || modality === 'pointer';
}
