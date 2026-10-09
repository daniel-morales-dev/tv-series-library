import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export function all<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function get<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  const result = db.prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

export function parseJsonArray(value: string | null): unknown[] {
  return value ? (JSON.parse(value) as unknown[]) : [];
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
