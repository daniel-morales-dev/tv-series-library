import { readFileSync } from 'node:fs';
import { cp, link, lstat, mkdir, readdir, rename, rm, rmdir, stat, statfs as realStatfs, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { configDir as defaultConfigDir, readUserConfig, writeUserConfig } from '../../config/config.ts';
import type { Statfs } from '../processing/cache.ts';

// T47e: moves the HLS packages to `<content>/.sala/hls`. The origin is never touched until `freeOrigin`.
// Everything is derived from the filesystem (a package is "moved" when it matches the origin), so an interrupted run
// resumes by skipping what is already there; the only persisted state is the journal that remembers the origin.

export type MigrationErrorCode =
  | 'invalid_path' | 'same_dir' | 'nested' | 'no_source' | 'no_space' | 'disk_absent' | 'not_verified'
  | 'no_config' | 'env_override' | 'running' | 'not_switched' | 'restart_required' | 'nothing_to_free';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MigrationDeps {
  statfs?: Statfs;
  /** True when both paths live on the same filesystem (hard links are possible). */
  sameDevice?: (a: string, b: string) => Promise<boolean>;
  linkFile?: (from: string, to: string) => Promise<void>;
  copyDir?: (from: string, to: string) => Promise<void>;
}

export interface TreeStats {
  files: number;
  bytes: number;
}

export interface PackageInfo extends TreeStats {
  name: string;
  /** Complete and identical (same file count and bytes) at the destination. */
  moved: boolean;
}

export interface PlanOptions {
  from: string;
  to: string;
  /** Free space that must remain after copying: the larger of this and `minFreePct` of the volume (same rule as T47d). */
  minFreeBytes: number;
  minFreePct: number;
  deps?: MigrationDeps;
}

export interface MigrationPlan {
  from: string;
  to: string;
  /** link: hard links on the same filesystem (no extra space); copy: another filesystem. */
  method: 'link' | 'copy';
  packages: PackageInfo[];
  pendingCount: number;
  movedCount: number;
  pendingBytes: number;
  totalBytes: number;
  freeBytes: number;
  minFreeBytes: number;
  /** Space the move needs on the destination volume (0 when linking). */
  requiredBytes: number;
  fits: boolean;
}

export interface Progress {
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  current: string | null;
}

export interface RunOptions extends PlanOptions {
  /** Checked before anything is created and before every package: an absent disk must never get a `.sala/`. */
  diskPresent: () => boolean;
  onProgress?: (progress: Progress) => void;
  /** Called once, after every package is verified: the only moment the pointer moves. */
  switchPointer: () => Promise<void>;
}

const PACKAGE = /^\d+$/;
const LINK_UNSUPPORTED = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EACCES', 'EOPNOTSUPP']);
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1).replace('.', ',');

export async function treeStats(dir: string): Promise<TreeStats | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const total = { files: 0, bytes: 0 };
  for (const e of entries) {
    if (e.isDirectory()) {
      const inner = await treeStats(join(dir, e.name));
      total.files += inner?.files ?? 0;
      total.bytes += inner?.bytes ?? 0;
    } else {
      total.files += 1;
      total.bytes += (await lstat(join(dir, e.name)).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

const same = (a: TreeStats | null, b: TreeStats | null) => !!a && !!b && a.files === b.files && a.bytes === b.bytes;

async function packageNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (!entries) throw new MigrationError('no_source', `No se encontró la carpeta de video ${root}.`);
  return entries.filter((e) => e.isDirectory() && PACKAGE.test(e.name)).map((e) => e.name).sort((a, b) => Number(a) - Number(b));
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

async function nearestExisting(path: string): Promise<string> {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (await stat(p).then(() => true, () => false)) return p;
    if (dirname(p) === p) return p;
  }
}

const defaultSameDevice = async (a: string, b: string) => (await stat(a)).dev === (await stat(await nearestExisting(b))).dev;

async function linkTree(from: string, to: string, linkFile: (a: string, b: string) => Promise<void>): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (e.isDirectory()) await linkTree(join(from, e.name), join(to, e.name), linkFile);
    else await linkFile(join(from, e.name), join(to, e.name));
  }
}

async function volume(to: string, o: PlanOptions) {
  const s = await (o.deps?.statfs ?? realStatfs)(await nearestExisting(to));
  const total = s.blocks * s.bsize;
  return { free: s.bavail * s.bsize, min: Math.max(o.minFreeBytes, (total * o.minFreePct) / 100) };
}

export async function buildPlan(o: PlanOptions): Promise<MigrationPlan> {
  const from = resolve(o.from);
  const to = resolve(o.to);
  if (from === to) throw new MigrationError('same_dir', 'El origen y el destino son la misma carpeta.');
  if (inside(to, from) || inside(from, to)) throw new MigrationError('nested', 'El origen y el destino no pueden estar uno dentro del otro.');
  const packages: PackageInfo[] = [];
  for (const name of await packageNames(from)) {
    const src = (await treeStats(join(from, name))) ?? { files: 0, bytes: 0 };
    packages.push({ name, ...src, moved: same(src, await treeStats(join(to, name))) });
  }
  const pending = packages.filter((p) => !p.moved);
  const pendingBytes = pending.reduce((sum, p) => sum + p.bytes, 0);
  const method = await (o.deps?.sameDevice ?? defaultSameDevice)(from, to) ? 'link' : 'copy';
  const { free, min } = await volume(to, o);
  const requiredBytes = method === 'link' || !pending.length ? 0 : pendingBytes + min;
  return {
    from, to, method, packages,
    pendingCount: pending.length,
    movedCount: packages.length - pending.length,
    pendingBytes,
    totalBytes: packages.reduce((sum, p) => sum + p.bytes, 0),
    freeBytes: free,
    minFreeBytes: min,
    requiredBytes,
    fits: free >= requiredBytes,
  };
}

const diskAbsent = () => new MigrationError('disk_absent', 'El disco de la biblioteca no está disponible. Conéctalo y vuelve a intentar: el avance se conserva.');

/**
 * Moves every pending package: link (or copy) into `<name>.tmp`, verify, rename. Packages already complete at the
 * destination are skipped, so a run that was interrupted just continues. The pointer moves only after the last
 * package is verified; the origin is never modified.
 */
export async function runMigration(o: RunOptions): Promise<{ moved: number; skipped: number }> {
  if (!o.diskPresent()) throw diskAbsent();
  const plan = await buildPlan(o);
  if (!plan.fits) {
    throw new MigrationError('no_space', `Poco espacio en el destino: quedan ${gb(plan.freeBytes)} GB libres y hacen falta ${gb(plan.requiredBytes)} GB.`);
  }
  const deps = o.deps ?? {};
  const linkFile = deps.linkFile ?? link;
  const copyDir = deps.copyDir ?? ((a: string, b: string) => cp(a, b, { recursive: true, errorOnExist: true }));
  let useLink = plan.method === 'link';
  await mkdir(plan.to, { recursive: true });

  const progress: Progress = { done: plan.movedCount, total: plan.packages.length, bytesDone: plan.totalBytes - plan.pendingBytes, bytesTotal: plan.totalBytes, current: null };
  o.onProgress?.({ ...progress });
  let moved = 0;
  for (const pkg of plan.packages.filter((p) => !p.moved)) {
    if (!o.diskPresent()) throw diskAbsent();
    const src = join(plan.from, pkg.name);
    const dest = join(plan.to, pkg.name);
    const tmp = `${dest}.tmp`;
    progress.current = pkg.name;
    await rm(tmp, { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true }); // present but incomplete: never switched to, so safe to rebuild
    try {
      if (useLink) {
        try {
          await linkTree(src, tmp, linkFile);
        } catch (err) {
          if (!LINK_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
          useLink = false; // this filesystem has no hard links: copy from here on, after checking the space it needs
          await rm(tmp, { recursive: true, force: true });
          const { free, min } = await volume(plan.to, o);
          if (free < plan.pendingBytes + min) throw new MigrationError('no_space', `Poco espacio en el destino: quedan ${gb(free)} GB libres y hacen falta ${gb(plan.pendingBytes + min)} GB.`);
        }
      }
      if (!useLink) await copyDir(src, tmp);
      if (!same(await treeStats(src), await treeStats(tmp))) {
        throw new MigrationError('not_verified', `La copia del paquete ${pkg.name} no coincide con el origen.`);
      }
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
    moved++;
    progress.done++;
    progress.bytesDone += pkg.bytes;
    o.onProgress?.({ ...progress });
  }

  for (const pkg of plan.packages) {
    if (!same(await treeStats(join(plan.from, pkg.name)), await treeStats(join(plan.to, pkg.name)))) {
      throw new MigrationError('not_verified', `El paquete ${pkg.name} no coincide con el origen tras mover.`);
    }
  }
  await o.switchPointer();
  return { moved, skipped: plan.movedCount };
}

export interface FreeResult {
  freedPackages: number;
  freedBytes: number;
  /** Origin packages left in place: no verified copy at the destination (e.g. created after the migration). */
  kept: string[];
}

/** Deletes the origin packages that are verified at the destination. The caller owns the confirmation. */
export async function freeOrigin(o: { from: string; to: string }): Promise<FreeResult> {
  const from = resolve(o.from);
  const to = resolve(o.to);
  const result: FreeResult = { freedPackages: 0, freedBytes: 0, kept: [] };
  if (from === to) throw new MigrationError('same_dir', 'El origen y el destino son la misma carpeta.');
  for (const name of await packageNames(from).catch(() => [])) {
    const src = await treeStats(join(from, name));
    if (!same(src, await treeStats(join(to, name)))) {
      result.kept.push(name);
      continue;
    }
    await rm(join(from, name), { recursive: true, force: true });
    result.freedPackages++;
    result.freedBytes += src?.bytes ?? 0;
  }
  await rmdir(from).catch(() => {}); // only succeeds when nothing else is left
  return result;
}

export interface Journal {
  from: string;
  to: string;
  startedAt: string;
}

const journalFile = (stateDir: string) => join(stateDir, 'hls-migration.json');

export function readJournal(stateDir: string): Journal | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(journalFile(stateDir), 'utf8'));
    const { from, to, startedAt } = raw as Record<string, unknown>;
    return typeof from === 'string' && typeof to === 'string' ? { from, to, startedAt: String(startedAt ?? '') } : null;
  } catch {
    return null;
  }
}

export async function writeJournal(stateDir: string, journal: Journal): Promise<void> {
  const file = journalFile(stateDir);
  await mkdir(stateDir, { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(journal, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

export const clearJournal = (stateDir: string) => rm(journalFile(stateDir), { force: true });

/** The pointer lives in config.json `hlsDir`; a DATA_DIR override ignores it, so migrating would silently do nothing. */
export function assertCanSwitchPointer(env: NodeJS.ProcessEnv, dir: string): void {
  if (env.DATA_DIR !== undefined) throw new MigrationError('env_override', 'DATA_DIR está definido y fija la ubicación del video: quítalo para poder mover los datos.');
  if (!readUserConfig({ dir, warn: () => {} })) throw new MigrationError('no_config', 'Primero elige la carpeta de la biblioteca en Ajustes (no hay configuración guardada).');
}

export function switchPointer(to: string, dir = defaultConfigDir()): void {
  const config = readUserConfig({ dir, warn: () => {} });
  if (!config) throw new MigrationError('no_config', 'Primero elige la carpeta de la biblioteca en Ajustes (no hay configuración guardada).');
  writeUserConfig({ ...config, hlsDir: resolve(to) }, dir);
}

export const readHlsPointer = (dir: string) => readUserConfig({ dir, warn: () => {} })?.hlsDir;
