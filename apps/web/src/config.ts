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

/** Copy shown on the empty library screen; `action` is the prominent button, `link` the low-key one. */
export interface EmptyLibraryHint {
  title: string;
  body: string;
  action: { label: string; to: string } | null;
  link: { label: string; to: string } | null;
}

/**
 * T57: a fresh install lands on an empty library with no idea where files go.
 * `ready` names the two subfolders the scanner reads; anything else (unset,
 * missing, config unreachable) sends the user to the wizard, which shows its
 * own error for `missing` and lets a re-linked folder be picked there.
 */
export function emptyLibraryHint(config: AppConfig | null): EmptyLibraryHint {
  const title = 'Tu biblioteca está vacía';
  if (config?.status === 'ready' && config.contentDir) {
    const base = config.contentDir.replace(/[/\\]+$/, '');
    return {
      title,
      body: `Pon tus series en ${base}/shows y tus películas en ${base}/films; aparecerán aquí solas en el próximo escaneo.`,
      action: null,
      link: { label: 'Cambiar carpeta', to: '/settings' },
    };
  }
  return {
    title,
    body: 'Antes de nada, elige la carpeta donde vivirán tus archivos.',
    action: { label: 'Configurar carpeta', to: '/setup' },
    link: null,
  };
}

export type SubmitError = { kind: 'confirm-create' } | { kind: 'error'; message: string };

export function submitError(code: string): SubmitError {
  if (code === 'not_found') return { kind: 'confirm-create' };
  if (code === 'invalid_path') return { kind: 'error', message: 'Escribe una ruta absoluta (por ejemplo /home/usuario/series).' };
  if (code === 'not_directory') return { kind: 'error', message: 'Esa ruta es un archivo, no una carpeta.' };
  return { kind: 'error', message: 'No se pudo guardar la carpeta. Intenta de nuevo.' };
}
