import type { DatabaseSync } from 'node:sqlite';
import { all, run } from '../../db/sql.ts';

export interface Suggestion {
  type: 'title' | 'person';
  id: number;
  label: string;
}

// Ingestion must call these whenever a title or person is created or renamed.
export function indexEntry(db: DatabaseSync, type: Suggestion['type'], id: number, label: string): void {
  run(db, 'DELETE FROM search_index WHERE ref_type = ? AND ref_id = ?', type, id);
  run(db, 'INSERT INTO search_index (ref_type, ref_id, label) VALUES (?, ?, ?)', type, id, label);
}

export function suggest(db: DatabaseSync, q: string, limit = 10): Suggestion[] {
  // Only letters/digits survive, so the quoted FTS query can never be malformed.
  const tokens = q.match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return [];
  const match = tokens.map((t) => `"${t}"*`).join(' ');
  return all<{ ref_type: Suggestion['type']; ref_id: number; label: string }>(
    db,
    'SELECT ref_type, ref_id, label FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ?',
    match,
    limit,
  ).map((r) => ({ type: r.ref_type, id: r.ref_id, label: r.label }));
}
