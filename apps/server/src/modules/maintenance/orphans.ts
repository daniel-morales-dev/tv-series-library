import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { all } from '../../db/sql.ts';
import { dirBytes } from '../processing/cache.ts';

export interface OrphanDir {
  id: number;
  bytes: number;
}

export interface OrphanScan {
  count: number;
  bytes: number;
  dirs: OrphanDir[];
}

export interface ScanInput {
  hlsDir: string;
  /** Ids a media_files row points at. */
  referenced: ReadonlySet<number>;
  /** Ids the processing module is using right now; defaults to none. */
  inFlight?: ReadonlySet<number>;
}

/** Ids with a queued or running process job: the same guard the cache trusts before evicting a package. */
export function inFlightIds(db: DatabaseSync): Set<number> {
  return new Set(
    all<{ media_file_id: number }>(db, "SELECT media_file_id FROM jobs WHERE type = 'process' AND status IN ('queued', 'running')").map(
      (r) => r.media_file_id,
    ),
  );
}

export function referencedIds(db: DatabaseSync): Set<number> {
  return new Set(all<{ id: number }>(db, 'SELECT id FROM media_files').map((r) => r.id));
}

/** `<hlsDir>/<id>` folders no row points at and no job is using; a missing HLS folder scans as empty. */
export async function listOrphans({ hlsDir, referenced, inFlight }: ScanInput): Promise<OrphanScan> {
  const root = resolve(hlsDir);
  const dirs: OrphanDir[] = [];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const id = Number(e.name);
    if (referenced.has(id) || inFlight?.has(id)) continue;
    dirs.push({ id, bytes: await dirBytes(join(root, e.name)) });
  }
  dirs.sort((a, b) => a.id - b.id);
  return { count: dirs.length, bytes: dirs.reduce((sum, d) => sum + d.bytes, 0), dirs };
}

/** Deletes every orphan package; each id is re-checked first so a row created since the scan wins over the purge. */
export async function purgeOrphans({ hlsDir, db }: { hlsDir: string; db: DatabaseSync }): Promise<{ removed: number; bytesFreed: number }> {
  const root = resolve(hlsDir);
  const scan = await listOrphans({ hlsDir: root, referenced: referencedIds(db), inFlight: inFlightIds(db) });
  const referenced = referencedIds(db);
  const inFlight = inFlightIds(db);
  let removed = 0;
  let bytesFreed = 0;
  for (const d of scan.dirs) {
    if (referenced.has(d.id) || inFlight.has(d.id)) continue;
    try {
      await rm(join(root, String(d.id)), { recursive: true, force: true });
      removed++;
      bytesFreed += d.bytes;
    } catch {
      // A folder that cannot be removed stays on disk and out of the count.
    }
  }
  return { removed, bytesFreed };
}
