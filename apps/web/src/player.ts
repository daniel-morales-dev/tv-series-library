import { languageName } from './languages.ts';
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

/** Next episode with a file, in season → episode order. Extras and unknown files have none. */
export function nextFile(detail: TitleDetail, fileId: number): { fileId: number; name: string } | null {
  const ordered = [...detail.seasons]
    .sort((a, b) => a.number - b.number)
    .flatMap((s) => [...s.episodes].sort((a, b) => a.number - b.number))
    .flatMap((e) => {
      const f = detail.files.find((x) => x.episodeId === e.id);
      return f ? [{ fileId: f.id, name: e.name || `Episodio ${e.number}` }] : [];
    });
  const i = ordered.findIndex((x) => x.fileId === fileId);
  return i >= 0 ? (ordered[i + 1] ?? null) : null;
}
