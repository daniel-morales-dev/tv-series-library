import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOTS } from '../modules/ingest/scanner.ts';

/** Hidden marker written at the content-folder root so a relocated disk can be recognized (T9/T22). */
export const MARKER_FILE = '.sala-library.json';

export interface UserConfig {
  /** Absolute path chosen by the first-run wizard (T22b); never edited by hand. */
  contentDir: string;
  libraryId?: string;
  /** T47d: absolute HLS folder (e.g. `<contentDir>/.sala/hls`); absent = `<stateDir>/hls`. */
  hlsDir?: string;
  /** T47d: `stat.dev` of a content folder that is a mount point of its own; absent = plain folder. */
  contentDev?: number;
  /** T58: TMDB Read Access Token saved from Settings; env `TMDB_READ_ACCESS_TOKEN` still wins over it. */
  tmdbToken?: string;
}

export interface ConfigOptions {
  /** Directory that holds config.json; defaults to the per-OS user config dir, overridable with SALA_CONFIG_DIR. */
  dir?: string;
  /** Warning sink for unreadable or corrupt files; defaults to console.warn. */
  warn?: (message: string) => void;
}

export type ConfigStatus =
  | { status: 'unset'; contentDir: null; libraryId: null; suggestedDefault: string | null }
  | { status: 'missing'; contentDir: string; libraryId: string | null; suggestedDefault: string | null }
  | { status: 'ready'; contentDir: string; libraryId: string; suggestedDefault: string | null };

export type SetContentDirResult =
  | { ok: false; error: 'invalid_path' | 'not_directory' | 'not_found' }
  | { ok: true; status: ConfigStatus };

/** ~/.config/sala on Linux (or XDG_CONFIG_HOME), %LOCALAPPDATA%\sala on Windows, ~/Library/Application Support/sala on macOS. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SALA_CONFIG_DIR) return env.SALA_CONFIG_DIR;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? homedir(), 'sala');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'sala');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'sala');
}

export function readUserConfig(options: ConfigOptions = {}): UserConfig | null {
  const file = join(options.dir ?? configDir(), 'config.json');
  const warn = options.warn ?? console.warn;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`No se pudo leer ${file}: ${(err as Error).message}. Se ignora la configuración.`);
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const { contentDir, libraryId, hlsDir, contentDev, tmdbToken } = parsed as Record<string, unknown>;
      if (typeof contentDir === 'string' && isAbsolute(contentDir)) {
        return {
          contentDir,
          ...(typeof libraryId === 'string' && libraryId ? { libraryId } : {}),
          ...(typeof hlsDir === 'string' && isAbsolute(hlsDir) ? { hlsDir } : {}),
          ...(typeof contentDev === 'number' ? { contentDev } : {}),
          ...(typeof tmdbToken === 'string' && tmdbToken.trim() ? { tmdbToken: tmdbToken.trim() } : {}),
        };
      }
    }
  } catch {
    // Falls through to the warning: a file we cannot understand counts as "no config".
  }
  warn(`config.json inválido en ${file}: se ignora y la app pedirá configurar la carpeta.`);
  return null;
}

export function writeUserConfig(config: UserConfig, dir = configDir()): void {
  writeJsonAtomic(join(dir, 'config.json'), config);
}

export function readMarker(contentDir: string, warn: (message: string) => void = console.warn): { libraryId: string } | null {
  const file = join(contentDir, MARKER_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`No se pudo leer el marcador ${file}: ${(err as Error).message}`);
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const { libraryId } = parsed as Record<string, unknown>;
      if (typeof libraryId === 'string' && libraryId) return { libraryId };
    }
  } catch {
    // Falls through to the warning.
  }
  warn(`Marcador inválido en ${file}: se reescribirá con la identidad adoptada.`);
  return null;
}

export function writeMarker(contentDir: string, libraryId: string): void {
  writeJsonAtomic(join(contentDir, MARKER_FILE), { libraryId });
}

/** Repository root (apps/server/src/config → 4 levels up); relative paths anchor here, never to the cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** env override → user config.json → default, always absolute and anchored to the repo root (same as scripts/dev.mjs). */
export function resolveContentDir(env: NodeJS.ProcessEnv = process.env, options: ConfigOptions & { root?: string } = {}): string {
  const config = readUserConfig({ ...options, dir: options.dir ?? configDir(env) });
  return resolve(options.root ?? REPO_ROOT, env.CONTENT_DIR || config?.contentDir || 'content');
}

/**
 * unset: no config.json; the folder may still come from env/root .env/default (legacy and dev flow).
 * ready: config + folder exist and the marker proves it is the configured library.
 * missing: the folder is gone, or it is not the configured library (no marker, another libraryId, or no longer the saved
 * device: an unmounted disk leaves an empty mount point). Never creates anything: only the wizard/PUT writes the marker.
 */
export function configStatus(resolvedContentDir: string, options: ConfigOptions = {}): ConfigStatus {
  const config = readUserConfig(options);
  const suggestedDefault = isDirectory(resolvedContentDir) ? resolvedContentDir : null;
  if (!config) return { status: 'unset', contentDir: null, libraryId: null, suggestedDefault };
  const missing = { status: 'missing', contentDir: config.contentDir, libraryId: config.libraryId ?? null, suggestedDefault } as const;
  if (!isDirectory(config.contentDir)) return missing;
  const marker = readMarker(config.contentDir, options.warn ?? console.warn);
  if (!marker || (config.libraryId && config.libraryId !== marker.libraryId) || !sameDevice(config)) return missing;
  if (!config.libraryId) writeUserConfig({ ...config, libraryId: marker.libraryId }, options.dir ?? configDir());
  return { status: 'ready', contentDir: config.contentDir, libraryId: marker.libraryId, suggestedDefault };
}

/**
 * Cheap, silent and side-effect free: the guard that runs on every stream request and worker tick.
 * Without config.json (legacy/dev flow) a folder that exists counts as present.
 */
export function libraryDiskPresent(resolvedContentDir: string, options: ConfigOptions = {}): boolean {
  const quiet = { ...options, warn: () => {} };
  const config = readUserConfig(quiet);
  if (!config) return isDirectory(resolvedContentDir);
  if (!isDirectory(config.contentDir)) return false;
  const marker = readMarker(config.contentDir, quiet.warn);
  return !!marker && (!config.libraryId || config.libraryId === marker.libraryId) && sameDevice(config);
}

// A content folder saved as a mount point must still be that device; a plain folder has nothing to compare.
function sameDevice(config: UserConfig): boolean {
  if (config.contentDev === undefined) return true;
  try {
    return statSync(config.contentDir).dev === config.contentDev;
  } catch {
    return false;
  }
}

/** `stat.dev` of `path` when it is a mount point of its own (differs from its parent), else undefined. */
function mountDev(path: string): number | undefined {
  try {
    const { dev } = statSync(path);
    return dev !== statSync(dirname(path)).dev ? dev : undefined;
  } catch {
    return undefined;
  }
}

/**
 * T28: scanning runs for `ready` and for `unset` whose env/.env/default folder exists (legacy and dev flow).
 * `missing`, and `unset` with a folder that does not exist (`suggestedDefault` null), never scan, requeue or process:
 * touching the catalog against the wrong folder marks every file as "source file not found".
 */
export function autoScanAllowed(status: ConfigStatus): boolean {
  return status.status === 'ready' || (status.status === 'unset' && status.suggestedDefault !== null);
}

export function setContentDir(input: string, options: { create?: boolean } & ConfigOptions = {}): SetContentDirResult {
  const path = expandHome(input);
  if (!isAbsolute(path)) return { ok: false, error: 'invalid_path' };
  let stats: Stats | undefined;
  try {
    stats = statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!options.create) return { ok: false, error: 'not_found' };
    mkdirSync(path, { recursive: true });
  }
  if (stats && !stats.isDirectory()) return { ok: false, error: 'not_directory' };
  // The scanner only reads `shows/` and `films/`: create them now so the user finds where to drop media.
  for (const sub of ROOTS) mkdirSync(join(path, sub), { recursive: true });
  const marker = readMarker(path, options.warn ?? console.warn);
  const previous = readUserConfig({ ...options, warn: () => {} });
  const same = previous?.contentDir === path;
  const libraryId = marker?.libraryId ?? (same ? previous.libraryId : undefined) ?? randomUUID();
  if (!marker) writeMarker(path, libraryId);
  const contentDev = mountDev(path);
  writeUserConfig(
    {
      contentDir: path,
      libraryId,
      ...(contentDev !== undefined ? { contentDev } : {}),
      ...(same && previous.hlsDir ? { hlsDir: previous.hlsDir } : {}),
      // T58: the TMDB token is app-level, not library-level: re-picking the folder never drops it.
      ...(previous?.tmdbToken ? { tmdbToken: previous.tmdbToken } : {}),
    },
    options.dir ?? configDir(),
  );
  return { ok: true, status: configStatus(path, options) };
}

export type SetTmdbTokenResult = { ok: false; error: 'no_config' } | { ok: true; tmdbConfigured: boolean };

/**
 * T58: stores (trimmed) or clears (empty string) the TMDB token in config.json, keeping the rest of the file.
 * Without config.json there is no library yet — the wizard writes it first — so there is nothing to merge into.
 */
export function setTmdbToken(token: string, options: ConfigOptions = {}): SetTmdbTokenResult {
  const dir = options.dir ?? configDir();
  const config = readUserConfig({ ...options, dir });
  if (!config) return { ok: false, error: 'no_config' };
  const trimmed = token.trim();
  const next: UserConfig = { ...config };
  if (trimmed) next.tmdbToken = trimmed;
  else delete next.tmdbToken;
  writeUserConfig(next, dir);
  return { ok: true, tmdbConfigured: trimmed !== '' };
}

/** T58: resolution order env `TMDB_READ_ACCESS_TOKEN` (wins) → config.json; null = ingesting offline. */
export function resolveTmdbToken(env: NodeJS.ProcessEnv = process.env, options: ConfigOptions = {}): string | null {
  const fromEnv = env.TMDB_READ_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readUserConfig({ ...options, dir: options.dir ?? configDir(env) })?.tmdbToken ?? null;
}

/** T60: where a brand-new library is proposed when no folder exists yet (installed app, no repo `content/`). */
export function defaultLibraryDir({ platform = process.platform, home = homedir() }: { platform?: NodeJS.Platform; home?: string } = {}): string {
  // macOS has no ~/Videos: the user-facing video folder there is ~/Movies.
  const folder = platform === 'darwin' ? 'Movies' : 'Videos';
  return (platform === 'win32' ? win32 : posix).join(home, folder, 'Sala');
}

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** mkdir -p plus tmp+rename so a crash never leaves a truncated config.json or marker. */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
