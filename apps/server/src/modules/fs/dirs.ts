import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export interface DirEntry { name: string; path: string }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[]; shortcuts: DirEntry[] }
export type FsError = 'invalid_path' | 'not_found' | 'not_directory' | 'forbidden';
export type ListResult = { ok: true; value: DirListing } | { ok: false; error: FsError };

export interface ListOptions {
  home?: string;
  /** Folders whose subfolders are offered as shortcuts (disks mounted by the desktop). */
  mountBases?: string[];
  showHidden?: boolean;
}

export const DEFAULT_MOUNT_BASES = ['/mnt', '/media', '/run/media'];

export const fsErrorMessage: Record<FsError, string> = {
  invalid_path: 'Escribe una ruta absoluta (por ejemplo /home/usuario/series).',
  not_found: 'Esa carpeta no existe.',
  not_directory: 'Esa ruta es un archivo, no una carpeta.',
  forbidden: 'No hay permiso para abrir esa carpeta.',
};

function subdirs(dir: string, showHidden: boolean): DirEntry[] {
  const out: DirEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!showHidden && e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    // Symlinks count as folders only when they point to one.
    if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(path))) continue;
    out.push({ name: e.name, path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeSubdirs(dir: string): DirEntry[] {
  try {
    return subdirs(dir, false);
  } catch {
    return [];
  }
}

function mountShortcuts(bases: string[]): DirEntry[] {
  const found: DirEntry[] = [];
  for (const base of bases) {
    for (const first of safeSubdirs(base)) {
      // /media/<user>/<disk> and /run/media/<user>/<disk> nest one level; /mnt/<disk> does not.
      const nested = /\/media$/.test(base) ? safeSubdirs(first.path) : [];
      found.push(...(nested.length ? nested : [first]));
    }
  }
  return found;
}

/** Read-only listing of the subfolders of an absolute path. Never lists files, never writes. */
export function listDirs(input: string | undefined, options: ListOptions = {}): ListResult {
  const home = options.home ?? homedir();
  const target = input === undefined || input === '' ? home : input;
  if (!isAbsolute(target)) return { ok: false, error: 'invalid_path' };

  let real: string;
  try {
    real = realpathSync(target);
    if (!statSync(real).isDirectory()) return { ok: false, error: 'not_directory' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'forbidden' };
    return { ok: false, error: code === 'ENOTDIR' ? 'not_directory' : 'not_found' };
  }

  let entries: DirEntry[];
  try {
    entries = subdirs(real, options.showHidden ?? false);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? 'not_found' : 'forbidden' };
  }

  const shortcuts: DirEntry[] = [
    { name: 'Raíz', path: '/' },
    { name: 'Inicio', path: home },
    ...mountShortcuts(options.mountBases ?? DEFAULT_MOUNT_BASES),
  ];
  const parent = dirname(real) === real ? null : dirname(real);
  return { ok: true, value: { path: real, parent, entries, shortcuts } };
}
