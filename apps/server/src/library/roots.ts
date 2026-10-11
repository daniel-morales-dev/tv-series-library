import type { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { run } from '../db/sql.ts';

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
