import type { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, rename, rm, stat, statfs as realStatfs } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { all, run } from '../../db/sql.ts';
import { type ProbeStreams, probeStreams as realProbe } from './ffmpeg.ts';
import { buildPlan } from './plan.ts';

export const GB = 1024 ** 3;
// A file streamed this recently counts as playing: its package is never evicted.
const PLAYING_GRACE_MS = 30 * 60_000;
const TOUCH_EVERY_MS = 60_000;
// Worst measured package/original ratios (docs/design/t47-data.md): copy ~1.0, x264 up to 1.3 (HEVC).
export const ESTIMATE_RATIO = { copy: 1.05, x264: 1.35 } as const;

export type Statfs = (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;

const gb = (bytes: number) => (bytes / GB).toFixed(1).replace('.', ',');

export class LowDiskError extends Error {
  readonly freeBytes: number;
  /** Free space that must exist before the job may start: the job's estimate plus the safety threshold. */
  readonly requiredBytes: number;
  /** The part of `requiredBytes` that the job itself will write. */
  readonly neededBytes: number;

  constructor(freeBytes: number, requiredBytes: number, neededBytes: number) {
    super(`Poco espacio en disco: quedan ${gb(freeBytes)} GB libres y hacen falta ${gb(requiredBytes)} GB. El procesado está en pausa hasta que se libere espacio.`);
    this.freeBytes = freeBytes;
    this.requiredBytes = requiredBytes;
    this.neededBytes = neededBytes;
  }
}

/** The library disk is not mounted: nothing may be written (a mkdir would create `.sala/` on the empty mount point). */
export class DiskAbsentError extends Error {
  constructor() {
    super('El disco de la biblioteca no está disponible. El procesado se reanuda solo cuando vuelva.');
  }
}

export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await dirBytes(path) : ((await stat(path).catch(() => null))?.size ?? 0);
  }
  return total;
}

// Stamps a play (or stream request) on the file; the write is skipped when the stamp is under a minute old.
export function touchPlayed(db: DatabaseSync, mediaFileId: number, nowMs = Date.now()): void {
  run(
    db,
    'UPDATE media_files SET last_played_at = ? WHERE id = ? AND (last_played_at IS NULL OR last_played_at < ?)',
    new Date(nowMs).toISOString(),
    mediaFileId,
    new Date(nowMs - TOUCH_EVERY_MS).toISOString(),
  );
}

export interface CacheOptions {
  db: DatabaseSync;
  dataDir: string;
  /** HLS root; defaults to `<dataDir>/hls`. */
  hlsDir?: string;
  contentDir: string;
  /** Throws DiskAbsentError when the library disk is gone; checked before anything is created. */
  assertDisk?: () => void;
  /** Copy packages are a regenerable cache: above this many bytes the least recently played are evicted. */
  budgetBytes: number;
  /** Free space that must remain on the HLS volume after writing: the larger of this and `minFreePct` of the volume. */
  minFreeBytes: number;
  minFreePct: number;
  probeStreams?: ProbeStreams;
  statfs?: Statfs;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

interface Candidate {
  id: number;
  path: string;
  hlsDir: string;
  bytes: number;
}

export function createCache(o: CacheOptions) {
  const { db } = o;
  const hlsRoot = resolve(o.hlsDir ?? join(o.dataDir, 'hls'));
  // `media_files.hls_dir` stays `hls/<id>` whatever the root is, so only its last segment is meaningful.
  const packageDir = (hlsDir: string) => join(hlsRoot, basename(hlsDir));
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const probe = o.probeStreams ?? realProbe;

  async function volume() {
    o.assertDisk?.();
    await mkdir(hlsRoot, { recursive: true });
    const s = await (o.statfs ?? realStatfs)(hlsRoot);
    const total = s.blocks * s.bsize;
    return { free: s.bavail * s.bsize, min: Math.max(o.minFreeBytes, (total * o.minFreePct) / 100) };
  }

  // Evictable = regenerable copy packages: ready, no job pending, not in use, not `protectId`, original still readable.
  // Least recently played first; never-played ones count from their creation.
  async function candidates(protectId: number): Promise<Candidate[]> {
    const rows = all<{ id: number; path: string; hls_dir: string; pkg_bytes: number }>(
      db,
      `SELECT id, path, hls_dir, pkg_bytes FROM media_files
       WHERE status = 'ready' AND pkg_mode = 'copy' AND hls_dir IS NOT NULL AND pkg_bytes IS NOT NULL AND id <> ?
         AND (last_played_at IS NULL OR last_played_at < ?)
         AND id NOT IN (SELECT media_file_id FROM jobs WHERE type = 'process' AND status IN ('queued', 'running'))
       ORDER BY COALESCE(last_played_at, created_at), id`,
      protectId,
      new Date(now() - PLAYING_GRACE_MS).toISOString(),
    );
    const out: Candidate[] = [];
    for (const r of rows) {
      // Without the original the package cannot be rebuilt (a deleted file, or a disk that is not mounted).
      if ((await stat(join(o.contentDir, r.path)).catch(() => null))?.isFile()) {
        out.push({ id: r.id, path: r.path, hlsDir: r.hls_dir, bytes: r.pkg_bytes });
      }
    }
    return out;
  }

  // The file stays ready (it will be rebuilt on its next play); the folder is renamed away before the row changes
  // so a concurrent rebuild never races a half-deleted package.
  async function evict(c: Candidate, why: string): Promise<void> {
    log('warn', `cache: evicting ${c.path} (${gb(c.bytes)} GB, ${why}); it is rebuilt from the original on its next play`);
    const dir = packageDir(c.hlsDir);
    const gone = `${dir}.evicting`;
    await rename(dir, gone).catch(() => {});
    run(db, 'UPDATE media_files SET hls_dir = NULL, pkg_bytes = NULL WHERE id = ?', c.id);
    await rm(gone, { recursive: true, force: true });
  }

  return {
    /** Evicts least recently played copy packages while the cache is over budget. */
    async enforceBudget(protectId: number): Promise<void> {
      const total = all<{ n: number }>(
        db,
        "SELECT COALESCE(SUM(pkg_bytes), 0) AS n FROM media_files WHERE status = 'ready' AND pkg_mode = 'copy' AND hls_dir IS NOT NULL",
      )[0].n;
      let over = total - o.budgetBytes;
      for (const c of over > 0 ? await candidates(protectId) : []) {
        if (over <= 0) break;
        await evict(c, `cache ${gb(total)} GB over the ${gb(o.budgetBytes)} GB budget`);
        over -= c.bytes;
      }
    },

    /** Makes `neededBytes` fit while keeping the free-space threshold, evicting cache if that is enough; else throws LowDiskError. */
    async ensureSpace(neededBytes: number, protectId: number): Promise<void> {
      const { free, min } = await volume();
      const required = neededBytes + min;
      if (free >= required) return;
      const list = await candidates(protectId);
      // Never empty the cache for nothing: when the whole cache would not be enough, evict nothing.
      if (free + list.reduce((sum, c) => sum + c.bytes, 0) < required) throw new LowDiskError(free, required, neededBytes);
      let available = free;
      for (const c of list) {
        if (available >= required) break;
        await evict(c, `low disk: ${gb(available)} GB free, ${gb(required)} GB needed`);
        available = (await volume()).free;
      }
      if (available < required) throw new LowDiskError(available, required, neededBytes);
    },

    /** Packages built before the cache existed: probes the source to learn whether each is a copy package (evictable). */
    async classifyLegacy(): Promise<void> {
      const rows = all<{ id: number; path: string; hls_dir: string }>(
        db,
        "SELECT id, path, hls_dir FROM media_files WHERE status = 'ready' AND hls_dir IS NOT NULL AND pkg_mode IS NULL",
      );
      for (const r of rows) {
        const src = join(o.contentDir, r.path);
        if (!(await stat(src).catch(() => null))?.isFile()) continue;
        try {
          const mode = buildPlan(await probe(src)).video.mode;
          run(db, 'UPDATE media_files SET pkg_mode = ?, pkg_bytes = ? WHERE id = ?', mode, await dirBytes(packageDir(r.hls_dir)), r.id);
        } catch {
          // Unprobeable: stays unclassified, which means never evicted.
        }
      }
    },
  };
}

export type Cache = ReturnType<typeof createCache>;
