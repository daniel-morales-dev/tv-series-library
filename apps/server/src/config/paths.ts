import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { REPO_ROOT, configDir, readUserConfig } from './config.ts';

export interface DataPaths {
  /** SQLite database, images and recovery copies. */
  stateDir: string;
  /** HLS packages (`<id>/` and `<id>.tmp/`). */
  hlsDir: string;
  /** env: explicit DATA_DIR · legacy: `<repo>/data` still holds the library · user: per-user default. */
  source: 'env' | 'legacy' | 'user';
  legacyDir: string;
  userDir: string;
  /** Set when the legacy layout is in use: tells the owner how to move to the user directory. */
  notice?: string;
}

export interface PathsOptions {
  /** Repository root that anchors relative DATA_DIR and the legacy `data/`; defaults to this checkout. */
  root?: string;
  platform?: NodeJS.Platform;
  home?: string;
  /** Directory holding config.json (T47d `hlsDir`); defaults to the per-OS user config dir. */
  configDir?: string;
}

/** `~/.local/share/sala` on Linux (or XDG_DATA_HOME), `%LOCALAPPDATA%\sala\data` on Windows, `~/Library/Application Support/sala/data` on macOS. */
export function userStateDir(env: NodeJS.ProcessEnv = process.env, { platform = process.platform, home = homedir() }: PathsOptions = {}): string {
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? home, 'sala', 'data');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'sala', 'data');
  const base = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(base, 'sala');
}

/**
 * Single resolver for where Sala keeps its data. Always absolute, never relative to the cwd.
 * 1. env DATA_DIR: explicit override, `stateDir = hlsDir = DATA_DIR` (the historical layout).
 * 2. per-user state once it exists (`library.db` there, written last by `sala migrate-state`).
 * 3. legacy `<repo>/data/library.db` while nothing newer exists: keep using it, never move it silently.
 * 4. otherwise the per-user default (fresh install).
 * HLS: config.json `hlsDir` (T47d), else the legacy `hls/` while that folder exists, else `<stateDir>/hls`.
 */
export function resolveDataPaths(env: NodeJS.ProcessEnv = process.env, options: PathsOptions = {}): DataPaths {
  const paths = resolveBase(env, options);
  // T47d: an absolute `hlsDir` in config.json wins; an explicit DATA_DIR keeps the historical layout (dev/test isolation).
  const hlsDir = paths.source === 'env' ? undefined : readUserConfig({ dir: options.configDir ?? configDir(env), warn: () => {} })?.hlsDir;
  return hlsDir ? { ...paths, hlsDir } : paths;
}

function resolveBase(env: NodeJS.ProcessEnv, options: PathsOptions): DataPaths {
  const root = options.root ?? REPO_ROOT;
  const legacyDir = resolve(root, 'data');
  const userDir = userStateDir(env, options);
  const base = { legacyDir, userDir };

  if (env.DATA_DIR !== undefined) {
    if (env.DATA_DIR === '') throw new Error('DATA_DIR está vacío. Quita la variable para usar la ubicación por defecto o dale una ruta.');
    const dir = resolve(root, env.DATA_DIR);
    return { ...base, stateDir: dir, hlsDir: join(dir, 'hls'), source: 'env' };
  }
  if (existsSync(join(userDir, 'library.db'))) {
    const legacyHls = join(legacyDir, 'hls');
    return { ...base, stateDir: userDir, hlsDir: existsSync(legacyHls) ? legacyHls : join(userDir, 'hls'), source: 'user' };
  }
  if (existsSync(join(legacyDir, 'library.db'))) {
    return {
      ...base,
      stateDir: legacyDir,
      hlsDir: join(legacyDir, 'hls'),
      source: 'legacy',
      notice: `Los datos siguen en ${legacyDir} (dentro del repo). Para moverlos a ${userDir} ejecuta: sala migrate-state --dry-run`,
    };
  }
  return { ...base, stateDir: userDir, hlsDir: join(userDir, 'hls'), source: 'user' };
}

/**
 * The server and its workers address HLS as `<stateDir>/hls`. True when that is where `hlsDir` really is
 * (same path, or the link `sala migrate-state` leaves); false would make the worker create a second, empty HLS tree.
 */
export function hlsReachable({ stateDir, hlsDir }: Pick<DataPaths, 'stateDir' | 'hlsDir'>): boolean {
  const inState = join(stateDir, 'hls');
  if (resolve(inState) === resolve(hlsDir)) return true;
  try {
    return realpathSync(inState) === realpathSync(hlsDir);
  } catch {
    return false;
  }
}
