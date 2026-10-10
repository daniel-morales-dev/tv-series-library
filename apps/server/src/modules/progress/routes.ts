import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { titleExists } from '../catalog/repository.ts';
import { profileExists } from '../profiles/repository.ts';
import { hideFromContinue, listContinueWatching, mediaFileExists, saveProgress, seasonExists, setFinished, setSeasonFinished } from './repository.ts';

const pid = { type: 'object', properties: { pid: { type: 'integer' } }, required: ['pid'] } as const;
const pidTitle = {
  type: 'object',
  properties: { pid: { type: 'integer' }, titleId: { type: 'integer' } },
  required: ['pid', 'titleId'],
} as const;

export function progressRoutes(api: FastifyInstance, db: DatabaseSync): void {
  const notFound = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(404).send({ error: 'not_found' });

  api.put<{ Params: { pid: number }; Body: { mediaFileId: number; positionS: number; durationS: number } }>(
    '/profiles/:pid/progress',
    {
      schema: {
        params: pid,
        body: {
          type: 'object',
          properties: {
            mediaFileId: { type: 'integer' },
            positionS: { type: 'number', minimum: 0 },
            durationS: { type: 'number', exclusiveMinimum: 0 },
          },
          required: ['mediaFileId', 'positionS', 'durationS'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { mediaFileId, positionS, durationS } = req.body;
      if (!profileExists(db, req.params.pid) || !mediaFileExists(db, mediaFileId)) return notFound(reply);
      saveProgress(db, req.params.pid, mediaFileId, positionS, durationS);
      return reply.code(204).send();
    },
  );

  api.get<{ Params: { pid: number } }>('/profiles/:pid/continue-watching', { schema: { params: pid } }, async (req, reply) =>
    profileExists(db, req.params.pid) ? listContinueWatching(db, req.params.pid) : notFound(reply),
  );

  api.delete<{ Params: { pid: number; titleId: number } }>(
    '/profiles/:pid/continue-watching/:titleId',
    { schema: { params: pidTitle } },
    async (req, reply) => {
      const { pid, titleId } = req.params;
      if (!profileExists(db, pid) || !titleExists(db, titleId)) return notFound(reply);
      hideFromContinue(db, pid, titleId);
      return reply.code(204).send();
    },
  );

  api.put<{ Params: { pid: number; titleId: number }; Body: { finished: boolean } }>(
    '/profiles/:pid/titles/:titleId/finished',
    {
      schema: {
        params: pidTitle,
        body: {
          type: 'object',
          properties: { finished: { type: 'boolean' } },
          required: ['finished'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { pid, titleId } = req.params;
      if (!profileExists(db, pid) || !titleExists(db, titleId)) return notFound(reply);
      setFinished(db, pid, titleId, req.body.finished);
      return reply.code(204).send();
    },
  );

  api.put<{ Params: { pid: number; titleId: number; season: number }; Body: { finished: boolean } }>(
    '/profiles/:pid/titles/:titleId/seasons/:season/finished',
    {
      schema: {
        params: {
          type: 'object',
          properties: { pid: { type: 'integer' }, titleId: { type: 'integer' }, season: { type: 'integer' } },
          required: ['pid', 'titleId', 'season'],
        },
        body: {
          type: 'object',
          properties: { finished: { type: 'boolean' } },
          required: ['finished'],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { pid, titleId, season } = req.params;
      if (!profileExists(db, pid) || !titleExists(db, titleId) || !seasonExists(db, titleId, season)) return notFound(reply);
      setSeasonFinished(db, pid, titleId, season, req.body.finished);
      return reply.code(204).send();
    },
  );
}
