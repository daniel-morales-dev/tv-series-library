interface Tracked {
  language: string | null;
}
interface FileTracks {
  extraLabel: string | null;
  audioTracks: Tracked[];
  subtitleTracks: Tracked[];
}
export interface Languages {
  audio: string[];
  subs: string[];
}

const UNKNOWN = 'Desconocido';
let names: Intl.DisplayNames | null | undefined;

export function languageName(code: string | null): string {
  if (!code || code === 'und' || code === 'zxx') return UNKNOWN;
  try {
    names ??= new Intl.DisplayNames(['es'], { type: 'language' });
    const n = names.of(code);
    if (n && n !== code) return n.charAt(0).toLocaleUpperCase('es') + n.slice(1);
  } catch {
    // not a language tag: show it as is
  }
  return code;
}

export const uniqueLanguages = (tracks: Tracked[]): string[] => [...new Set(tracks.map((t) => languageName(t.language)))];

export const fileLanguages = (f: FileTracks): Languages => ({ audio: uniqueLanguages(f.audioTracks), subs: uniqueLanguages(f.subtitleTracks) });

/** Languages across the title's main files (extras excluded). */
export function titleLanguages(files: FileTracks[]): Languages {
  const main = files.filter((f) => !f.extraLabel);
  return { audio: uniqueLanguages(main.flatMap((f) => f.audioTracks)), subs: uniqueLanguages(main.flatMap((f) => f.subtitleTracks)) };
}
