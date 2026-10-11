import type { DatabaseSync } from 'node:sqlite';
import { all, run } from '../../db/sql.ts';
import { SUMMARY_COLUMNS, availableTitles, toSummary } from '../catalog/repository.ts';
import { rootAvailability } from '../../library/roots.ts';

export function listMyList(db: DatabaseSync, profileId: number) {
  const rows = all<Record<string, any>>(
    db,
    `SELECT ${SUMMARY_COLUMNS} FROM my_list ml JOIN titles t ON t.id = ml.title_id
     WHERE ml.profile_id = ? ORDER BY ml.added_at DESC, ml.rowid DESC`,
    profileId,
  );
  const available = availableTitles(db, rootAvailability(db), rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, available.has(r.id)));
}

export function addToMyList(db: DatabaseSync, profileId: number, titleId: number): void {
  run(db, 'INSERT OR IGNORE INTO my_list (profile_id, title_id) VALUES (?, ?)', profileId, titleId);
}

export function removeFromMyList(db: DatabaseSync, profileId: number, titleId: number): void {
  run(db, 'DELETE FROM my_list WHERE profile_id = ? AND title_id = ?', profileId, titleId);
}
