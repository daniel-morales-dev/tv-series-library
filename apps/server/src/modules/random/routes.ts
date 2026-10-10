import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { all } from '../../db/sql.ts';
import { pickRandom, type Candidate } from './pick.ts';

export function randomRoutes(api: FastifyInstance, db: DatabaseSync): void {
  api.get<{ Querystring: { kind?: 'movie' | 'series' | 'anime'; profile?: number } }>(
    '/random',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            kind: { enum: ['movie', 'series', 'anime'] },
            profile: { type: 'integer' },
          },
        },
      },
    },
    async (req, reply) => {
      const rows = all<{ mediaFileId: number; titleId: number; episodic: number; watched: number }>(
        db,
        `SELECT mf.id AS mediaFileId, mf.title_id AS titleId, mf.episode_id IS NOT NULL AS episodic,
           COALESCE(wp.completed, 0) AS watched
         FROM media_files mf
         JOIN titles t ON t.id = mf.title_id
         LEFT JOIN watch_progress wp ON wp.media_file_id = mf.id AND wp.profile_id = ?
         WHERE mf.status = 'ready' AND mf.extra_label IS NULL AND (? IS NULL OR t.kind = ?)`,
        req.query.profile ?? null,
        req.query.kind ?? null,
        req.query.kind ?? null,
      );
      const pick = pickRandom(rows.map((r) => ({ ...r, episodic: r.episodic === 1, watched: r.watched === 1 })));
      return pick
        ? { titleId: pick.titleId, mediaFileId: pick.mediaFileId }
        : reply.code(404).send({ error: 'not_found' });
    },
  );
}
