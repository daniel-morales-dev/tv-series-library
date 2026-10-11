export const TOTAL_STEPS = 3;

export function stepLabel(step: number): string {
  return `Paso ${step} de ${TOTAL_STEPS}`;
}

/** The server's separator, inferred from a path it proposed; the browser cannot know the OS itself. */
export function pathSeparator(suggested: string): '\\' | '/' {
  return suggested.includes('\\') ? '\\' : '/';
}

export function layoutDiagram(sep: string): string {
  return [
    `Sala${sep}          ← elige esta carpeta`,
    `  shows${sep}       ← series y anime (una carpeta por serie)`,
    `  films${sep}       ← películas`,
  ].join('\n');
}

/** Parent folder when `path` points at shows/films (users often pick the child by mistake), else null. */
export function parentIfMediaRoot(path: string): string | null {
  const trimmed = path.trim().replace(/[/\\]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut <= 0) return null;
  if (!/^(shows|films)$/i.test(trimmed.slice(cut + 1))) return null;
  return trimmed.slice(0, cut);
}

export const tmdbSkipNote =
  'Sin token, los títulos salen del nombre del archivo y sin pósters. Puedes agregarlo después en Ajustes.';

export const tmdbGuide = [
  'Crea una cuenta gratis en themoviedb.org.',
  'Entra a Ajustes → API.',
  'Solicita una clave de uso personal y completa el formulario.',
  'Copia el «API Read Access Token» (el texto largo), no la «API Key».',
];
