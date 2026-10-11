import { randomUUID } from 'node:crypto';
import { constants, statSync, accessSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { expandHome, readMarker, writeMarker } from '../../config/config.ts';
import { candidateRoots, findMovedLibrary } from '../../config/relocate.ts';
import { all, get, run } from '../../db/sql.ts';
import { rootStatus } from '../../library/roots.ts';

export interface RootsRoutesDeps {
  /** Live configured folder for the primary root (T22 PUT can switch it while the server runs). */
  contentDir?: () => string;
  /** Mount parents scanned for a moved root (T22c); defaults to the platform's removable-media locations. */
  mountRoots?: () => string[];
}

/** One location as the web shows it. `path` is where the server looks now; `lastKnownPath` is what was saved. */
interface RootDto {
  id: number;
  label: string | null;
  path: string | null;
  lastKnownPath: string | null;
  present: boolean;
  sameLibrary: boolean | null;
  files: number;
  suggestion: string | null;
}

interface RootRow {
  id: number;
  library_id: string | null;
  last_known_path: string | null;
  label: string | null;
}

const ROW_COLUMNS = 'id, library_id, last_known_path, label';
const idParams = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } as const;
const pathBody = { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false } as const;

const invalidPath = { error: 'invalid_path', message: 'La ruta no existe, no es una carpeta o no se puede leer.' };
const notFound = { error: 'not_found', message: 'No se encontró la ubicación.' };
const otherLibrary = { error: 'other_library', message: 'Esa carpeta pertenece a otra biblioteca.' };

export function rootsRoutes(api: FastifyInstance, db: DatabaseSync, deps: RootsRoutesDeps = {}): void {
  const liveDir = deps.contentDir;

  function rowById(id: number): RootRow | undefined {
    return get<RootRow>(db, `SELECT ${ROW_COLUMNS} FROM library_roots WHERE id = ? AND forgotten = 0`, id);
  }

  // A root is never listed once forgotten; its rows and marker stay for a possible re-link.
  function list(): RootDto[] {
    return all<RootRow>(db, `SELECT ${ROW_COLUMNS} FROM library_roots WHERE forgotten = 0 ORDER BY position, id`).map(dto);
  }

  function dto(row: RootRow): RootDto {
    const path = (row.id === 1 ? liveDir?.() : undefined) ?? row.last_known_path;
    const status = rootStatus(db, row.id, { fallbackPath: path ?? undefined });
    return {
      id: row.id,
      label: row.label,
      path,
      lastKnownPath: row.last_known_path,
      present: status.present,
      // A root never linked to a library has no identity to compare against.
      sameLibrary: row.library_id === null ? null : status.sameLibrary,
      files: get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM media_files WHERE root_id = ?', row.id)!.n,
      suggestion: status.present ? null : suggestion(row),
    };
  }

  // Read-only and bounded: the absent root's marker may have reappeared under a mount point (T22c).
  function suggestion(row: RootRow): string | null {
    if (!row.library_id || !row.last_known_path) return null;
    const primary = get<{ last_known_path: string | null }>(db, 'SELECT last_known_path FROM library_roots WHERE id = 1')?.last_known_path ?? null;
    const roots = [...new Set([...(deps.mountRoots?.() ?? candidateRoots(liveDir?.() ?? primary)), dirname(row.last_known_path)])];
    return findMovedLibrary({ libraryId: row.library_id, roots, exclude: row.last_known_path })[0] ?? null;
  }

  // Both the new folder and the relink need a writable directory; the marker write is part of the answer.
  function usableDir(path: string): boolean {
    try {
      if (!statSync(path).isDirectory()) return false;
      accessSync(path, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  function normalize(input: string): string {
    return resolve(expandHome(input));
  }

  // Same folder or same identity: the root keeps its id, rows and label; path and marker are refreshed.
  function relink(row: RootRow, path: string): RootDto {
    const libraryId = row.library_id ?? randomUUID();
    run(db, 'UPDATE library_roots SET library_id = ?, last_known_path = ?, label = COALESCE(label, ?), forgotten = 0 WHERE id = ?', libraryId, path, basename(path), row.id);
    if (readMarker(path, () => {})?.libraryId !== libraryId) writeMarker(path, libraryId);
    return dto({ ...row, library_id: libraryId, last_known_path: path, label: row.label ?? basename(path) });
  }

  api.get('/roots', async () => ({ roots: list() }));

  api.post<{ Body: { path: string } }>('/roots', { schema: { body: pathBody } }, async (req, reply) => {
    const path = normalize(req.body.path);
    if (!usableDir(path)) return reply.code(400).send(invalidPath);
    const marker = readMarker(path, (message) => req.log.warn(message));
    if (marker) {
      const byMarker = get<RootRow>(db, `SELECT ${ROW_COLUMNS} FROM library_roots WHERE library_id = ?`, marker.libraryId);
      if (byMarker) return { root: relink(byMarker, path) };
      return reply.code(409).send(otherLibrary);
    }
    const byPath = get<RootRow>(db, `SELECT ${ROW_COLUMNS} FROM library_roots WHERE last_known_path = ? ORDER BY id LIMIT 1`, path);
    if (byPath) return { root: relink(byPath, path) };
    const libraryId = randomUUID();
    const position = get<{ position: number }>(db, 'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM library_roots')!.position;
    const id = run(db, 'INSERT INTO library_roots (library_id, last_known_path, label, position) VALUES (?, ?, ?, ?)', libraryId, path, basename(path), position).lastInsertId;
    writeMarker(path, libraryId);
    return reply.code(201).send({ root: dto({ id, library_id: libraryId, last_known_path: path, label: basename(path) }) });
  });

  // Repoints an existing root (same id, rows and HLS) at the folder where its disk was found again.
  api.post<{ Params: { id: number }; Body: { path: string } }>(
    '/roots/:id/relocate',
    { schema: { params: idParams, body: pathBody } },
    async (req, reply) => {
      const row = rowById(req.params.id);
      if (!row) return reply.code(404).send(notFound);
      const path = normalize(req.body.path);
      if (!usableDir(path)) return reply.code(400).send(invalidPath);
      const marker = readMarker(path, (message) => req.log.warn(message));
      let libraryId = row.library_id;
      if (marker) {
        if (libraryId === null) {
          // The root never had an identity: adopt the folder's own marker, unless another root already owns it.
          if (get(db, 'SELECT 1 AS x FROM library_roots WHERE library_id = ? AND id <> ?', marker.libraryId, row.id)) return reply.code(409).send(otherLibrary);
          libraryId = marker.libraryId;
        } else if (marker.libraryId !== libraryId) {
          return reply.code(409).send(otherLibrary);
        }
      } else if (libraryId !== null) {
        // A marked root is only ever relocated onto its own marker: an unmarked folder is not that disk.
        return reply.code(409).send({ error: 'not_moved', message: 'No se encontró esta ubicación en esa carpeta.' });
      } else {
        libraryId = randomUUID();
      }
      run(db, 'UPDATE library_roots SET library_id = ?, last_known_path = ?, label = COALESCE(label, ?) WHERE id = ?', libraryId, path, basename(path), row.id);
      if (readMarker(path, () => {})?.libraryId !== libraryId) writeMarker(path, libraryId);
      return { root: dto({ ...row, library_id: libraryId, last_known_path: path, label: row.label ?? basename(path) }) };
    },
  );

  api.delete<{ Params: { id: number } }>('/roots/:id', { schema: { params: idParams } }, async (req, reply) => {
    if (req.params.id === 1) return reply.code(400).send({ error: 'primary_root', message: 'La ubicación principal no se puede olvidar.' });
    const result = run(db, 'UPDATE library_roots SET forgotten = 1 WHERE id = ? AND forgotten = 0', req.params.id);
    return result.changes ? reply.code(204).send() : reply.code(404).send(notFound);
  });
}
