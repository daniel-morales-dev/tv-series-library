import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Hidden marker written at the content-folder root so a relocated disk can be recognized (T9/T22). */
export const MARKER_FILE = '.sala-library.json';

export interface UserConfig {
  /** Absolute path chosen by the first-run wizard (T22b); never edited by hand. */
  contentDir: string;
  libraryId?: string;
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

/** ~/.config/sala on Linux (or XDG_CONFIG_HOME), %LOCALAPPDATA%\sala on Windows. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SALA_CONFIG_DIR) return env.SALA_CONFIG_DIR;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? homedir(), 'sala');
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
      const { contentDir, libraryId } = parsed as Record<string, unknown>;
      if (typeof contentDir === 'string' && isAbsolute(contentDir)) {
        return { contentDir, ...(typeof libraryId === 'string' && libraryId ? { libraryId } : {}) };
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

/** env override → user config.json → default; the root .env is resolved by the launcher (dev only). */
export function resolveContentDir(env: NodeJS.ProcessEnv = process.env, options: ConfigOptions = {}): string {
  const config = readUserConfig({ ...options, dir: options.dir ?? configDir(env) });
  return env.CONTENT_DIR ?? config?.contentDir ?? './content';
}

/**
 * unset: no config.json, nothing to watch. ready: config + folder exist; the marker and the config adopt
 * each other's libraryId. missing: the configured folder is gone; never create it, never scan, no empty library.
 */
export function configStatus(resolvedContentDir: string, options: ConfigOptions = {}): ConfigStatus {
  const config = readUserConfig(options);
  const suggestedDefault = isDirectory(resolvedContentDir) ? resolvedContentDir : null;
  if (!config) return { status: 'unset', contentDir: null, libraryId: null, suggestedDefault };
  if (!isDirectory(config.contentDir)) {
    return { status: 'missing', contentDir: config.contentDir, libraryId: config.libraryId ?? null, suggestedDefault };
  }
  const marker = readMarker(config.contentDir, options.warn ?? console.warn);
  const libraryId = marker?.libraryId ?? config.libraryId ?? randomUUID();
  if (!marker) writeMarker(config.contentDir, libraryId);
  if (config.libraryId !== libraryId) {
    writeUserConfig({ contentDir: config.contentDir, libraryId }, options.dir ?? configDir());
  }
  return { status: 'ready', contentDir: config.contentDir, libraryId, suggestedDefault };
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
  const marker = readMarker(path, options.warn ?? console.warn);
  const libraryId = marker?.libraryId ?? randomUUID();
  if (!marker) writeMarker(path, libraryId);
  writeUserConfig({ contentDir: path, libraryId }, options.dir ?? configDir());
  return { ok: true, status: configStatus(path, options) };
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
