import type { DatabaseSync } from 'node:sqlite';
import { all, get, run, transaction } from '../../db/sql.ts';

export type FranchiseRelation = 'sequel' | 'prequel';

export class FranchiseError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

interface Row {
  id: number;
  title: string;
  franchise_id: number | null;
}

// A franchise with fewer than two titles groups nothing.
function dropIfTrivial(db: DatabaseSync, franchiseId: number): void {
  const members = all<{ id: number }>(db, 'SELECT id FROM titles WHERE franchise_id = ?', franchiseId);
  if (members.length >= 2) return;
  run(db, 'UPDATE titles SET franchise_id = NULL, franchise_order = NULL WHERE franchise_id = ?', franchiseId);
  run(db, 'DELETE FROM franchises WHERE id = ?', franchiseId);
}

export function assertTitleExists(db: DatabaseSync, id: number): void {
  if (!get(db, 'SELECT 1 FROM titles WHERE id = ?', id)) throw new FranchiseError(404, 'franchise_title_not_found');
}

// Puts `titleId` in the franchise of `ofTitleId` (created, named after it, when it has none).
export function linkFranchise(db: DatabaseSync, titleId: number, ofTitleId: number, relation: FranchiseRelation = 'sequel'): number {
  if (titleId === ofTitleId) throw new FranchiseError(400, 'franchise_self');
  return transaction(db, () => {
    const title = get<Row>(db, 'SELECT id, title, franchise_id FROM titles WHERE id = ?', titleId);
    if (!title) throw new FranchiseError(404, 'not_found');
    const of = get<Row>(db, 'SELECT id, title, franchise_id FROM titles WHERE id = ?', ofTitleId);
    if (!of) throw new FranchiseError(404, 'franchise_title_not_found');

    let franchiseId = of.franchise_id;
    if (franchiseId === null) {
      franchiseId = run(db, 'INSERT INTO franchises (name) VALUES (?)', of.title).lastInsertId;
      run(db, 'UPDATE titles SET franchise_id = ?, franchise_order = 1 WHERE id = ?', franchiseId, of.id);
    }
    if (title.franchise_id !== null) {
      run(db, 'UPDATE titles SET franchise_id = NULL, franchise_order = NULL WHERE id = ?', titleId);
      if (title.franchise_id !== franchiseId) dropIfTrivial(db, title.franchise_id);
    }

    if (relation === 'prequel') {
      run(db, 'UPDATE titles SET franchise_order = franchise_order + 1 WHERE franchise_id = ?', franchiseId);
      run(db, 'UPDATE titles SET franchise_id = ?, franchise_order = 1 WHERE id = ?', franchiseId, titleId);
    } else {
      const max = get<{ m: number | null }>(db, 'SELECT MAX(franchise_order) AS m FROM titles WHERE franchise_id = ?', franchiseId)?.m ?? 0;
      run(db, 'UPDATE titles SET franchise_id = ?, franchise_order = ? WHERE id = ?', franchiseId, max + 1, titleId);
    }
    return franchiseId;
  });
}

export function unlinkFranchise(db: DatabaseSync, titleId: number): boolean {
  return transaction(db, () => {
    const row = get<{ franchise_id: number | null }>(db, 'SELECT franchise_id FROM titles WHERE id = ?', titleId);
    if (row?.franchise_id == null) return false;
    run(db, 'UPDATE titles SET franchise_id = NULL, franchise_order = NULL WHERE id = ?', titleId);
    dropIfTrivial(db, row.franchise_id);
    return true;
  });
}

export function getFranchise(db: DatabaseSync, titleId: number, franchiseId: number | null) {
  if (franchiseId === null) return null;
  const franchise = get<{ id: number; name: string }>(db, 'SELECT id, name FROM franchises WHERE id = ?', franchiseId);
  const items = all<Record<string, any>>(
    db,
    `SELECT id, title, poster_path, kind, year, franchise_order FROM titles
     WHERE franchise_id = ? ORDER BY franchise_order, id`,
    franchiseId,
  ).map((t) => ({
    id: t.id,
    name: t.title,
    posterPath: t.poster_path,
    kind: t.kind,
    year: t.year,
    order: t.franchise_order,
    current: t.id === titleId,
  }));
  return franchise && items.length >= 2 ? { id: franchise.id, name: franchise.name, items } : null;
}
