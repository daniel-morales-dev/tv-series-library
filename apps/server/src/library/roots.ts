import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { readMarker } from '../config/config.ts';
import { all, get, run } from '../db/sql.ts';

/** A content folder, or a getter for it (multi-root: the getter receives the root id, default 1). */
export type RootDir = string | ((rootId: number) => string);

/** Absolute path of a file/folder inside its library root. */
export function sourcePath(base: RootDir, rootId: number | undefined, rel: string): string {
  return join(typeof base === 'function' ? base(rootId ?? 1) : base, rel);
}

/**
 * Links the placeholder root (id 1) to the configured library. The id and label are set once; the last known
 * path is refreshed on every boot. A call with a different libraryId is a no-op.
 */
export function linkPrimaryRoot(db: DatabaseSync, o: { libraryId: string; path: string }): void {
  run(
    db,
    `UPDATE library_roots SET
       library_id = COALESCE(library_id, ?),
       label = CASE WHEN library_id IS NULL THEN ? ELSE label END,
       last_known_path = CASE WHEN library_id IS NULL OR library_id = ? THEN ? ELSE last_known_path END
     WHERE id = 1`,
    o.libraryId,
    basename(o.path),
    o.libraryId,
    o.path,
  );
}

/** What a root looks like right now: whether its folder is still the registered library. */
export interface RootStatus {
  present: boolean;
  label: string | null;
  lastKnownPath: string | null;
  sameLibrary: boolean;
}

export interface RootStatusOptions {
  /** Live folder for a root the DB has no last known path for (the configured folder on legacy/dev boots). */
  fallbackPath?: string;
  /** `stat.dev` saved when the root was registered; a different device at the same path is not that root. */
  dev?: number;
  warn?: (message: string) => void;
}

/**
 * Availability of one root, derived (never stored): the folder must still exist, carry the marker of the library
 * registered for it, and — when a device was saved — still be that device. A root never linked yet counts as
 * present: legacy/dev single-folder setups have nothing to check.
 */
export function rootStatus(db: DatabaseSync, rootId: number, o: RootStatusOptions = {}): RootStatus {
  const row = get<{ library_id: string | null; last_known_path: string | null; label: string | null }>(
    db,
    'SELECT library_id, last_known_path, label FROM library_roots WHERE id = ?',
    rootId,
  );
  const lastKnownPath = row?.last_known_path ?? o.fallbackPath ?? null;
  const base = { label: row?.label ?? null, lastKnownPath };
  if (!row) return { ...base, present: false, sameLibrary: false };
  if (!lastKnownPath) return { ...base, present: true, sameLibrary: true };
  const stats = statSync(lastKnownPath, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) return { ...base, present: false, sameLibrary: false };
  const marker = readMarker(lastKnownPath, o.warn ?? (() => {}));
  const sameLibrary = row.library_id === null || marker?.libraryId === row.library_id;
  const present = sameLibrary && (row.library_id === null || marker !== null) && (o.dev === undefined || stats.dev === o.dev);
  return { ...base, present, sameLibrary };
}

/** Present roots keyed by id, so a DTO can derive availability for many files with one stat per root. */
export function rootAvailability(db: DatabaseSync, o: RootStatusOptions = {}): Map<number, boolean> {
  return new Map(all<{ id: number }>(db, 'SELECT id FROM library_roots').map((r) => [r.id, rootStatus(db, r.id, o).present]));
}

export interface AvailabilityFile {
  root_id: number;
  hls_dir: string | null;
  pkg_mode: string | null;
}

/**
 * A file plays while its root is present, or its HLS package plays without the source (an x264 encode is
 * self-contained; a copy package is only a cache and is never a guarantee).
 */
export function available(db: DatabaseSync, file: AvailabilityFile, o: RootStatusOptions = {}): boolean {
  return availableFrom(rootAvailability(db, o), file);
}

/** `available` against an already computed `rootAvailability` map; an unknown root counts as present. */
export function availableFrom(roots: ReadonlyMap<number, boolean>, file: AvailabilityFile): boolean {
  return roots.get(file.root_id) !== false || (file.hls_dir !== null && file.pkg_mode === 'x264');
}
