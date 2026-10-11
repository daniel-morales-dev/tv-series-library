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
  /** T58: whether a TMDB token is resolvable (env or config.json). Sent by GET /api/config; older payloads may omit it. */
  tmdbConfigured?: boolean;
  /** T60: proposed folder for a brand-new library (e.g. ~/Videos/Sala), created on save. Older payloads may omit it. */
  newLibraryDir?: string;
}

/** T60: an existing default folder wins; otherwise propose a new one so a fresh install never shows an empty field. */
export function suggestedFolder(config: Pick<AppConfig, 'suggestedDefault' | 'newLibraryDir'>): string {
  return config.suggestedDefault || config.newLibraryDir || '';
}

/** T58: derived UI state of the TMDB section in Settings; the token itself never round-trips through here. */
export interface TmdbSectionState {
  /** State line: a token is resolvable or not. */
  state: string;
  /** Guardar stays available (an empty token clears the saved one) and locks while a request is in flight. */
  canSave: boolean;
  /** Probar needs something to test: the typed token or an already saved one. */
  canTest: boolean;
}

export function tmdbSectionState(config: AppConfig | null, input: string, busy: boolean): TmdbSectionState {
  const configured = config?.tmdbConfigured === true;
  return {
    state: configured ? 'Configurado ✓' : 'Sin configurar',
    canSave: !busy,
    canTest: !busy && (input.trim() !== '' || configured),
  };
}

/**
 * Where the boot guard sends `path`, or null to let it through.
 * `missing` (chosen folder absent) forces /setup, which shows its own error.
 * `unset` forces the wizard only on a first run (no existing default folder);
 * with one, the development folder from .env keeps working.
 */
export function guardRedirect(config: Pick<AppConfig, 'status' | 'suggestedDefault'>, path: string): string | null {
  if (config.status === 'ready') return path === '/setup' ? '/' : null;
  if (config.status === 'missing' || !config.suggestedDefault) return path === '/setup' ? null : '/setup';
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
  if (code === 'invalid_path') return { kind: 'error', message: 'Escribe la ruta completa de la carpeta (por ejemplo C:\\Users\\tu-usuario\\Videos\\Sala o /home/tu-usuario/Videos/Sala).' };
  if (code === 'not_directory') return { kind: 'error', message: 'Esa ruta es un archivo, no una carpeta.' };
  return { kind: 'error', message: 'No se pudo guardar la carpeta. Intenta de nuevo.' };
}
