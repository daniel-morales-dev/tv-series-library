export type ConfigState = 'unset' | 'ready' | 'missing';

/** A folder carrying this library's marker found elsewhere (T22c); only suggested, the user accepts it. */
export interface LibraryCandidate {
  path: string;
  label: string;
}

export interface AppConfig {
  status: ConfigState;
  contentDir: string | null;
  libraryId: string | null;
  suggestedDefault: string;
}

/**
 * Where the boot guard sends `path`, or null to let it through.
 * Only `missing` (chosen folder absent) forces /setup, which shows its own error.
 * `unset` never forces the wizard: the development folder from .env keeps working.
 */
export function guardRedirect(status: ConfigState, path: string): string | null {
  if (status === 'ready') return path === '/setup' ? '/' : null;
  if (status === 'missing') return path === '/setup' ? null : '/setup';
  return null;
}

export type SubmitError = { kind: 'confirm-create' } | { kind: 'error'; message: string };

export function submitError(code: string): SubmitError {
  if (code === 'not_found') return { kind: 'confirm-create' };
  if (code === 'invalid_path') return { kind: 'error', message: 'Escribe una ruta absoluta (por ejemplo /home/usuario/series).' };
  if (code === 'not_directory') return { kind: 'error', message: 'Esa ruta es un archivo, no una carpeta.' };
  return { kind: 'error', message: 'No se pudo guardar la carpeta. Intenta de nuevo.' };
}
