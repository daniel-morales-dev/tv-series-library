import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { isUniqueViolation } from '../../db/sql.ts';
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  updateProfile,
  type ProfileInput,
} from './repository.ts';

const fields = {
  name: { type: 'string', minLength: 1, maxLength: 50 },
  avatar: { type: ['string', 'null'], maxLength: 200 },
  theme: { enum: ['dark', 'light'] },
  preferredAudioLang: { type: ['string', 'null'], maxLength: 10 },
  preferredSubtitleLang: { type: ['string', 'null'], maxLength: 10 },
} as const;

const idParams = { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } as const;

export function profileRoutes(api: FastifyInstance, db: DatabaseSync): void {
  api.get('/profiles', async () => listProfiles(db));

  api.post<{ Body: ProfileInput & { name: string } }>(
    '/profiles',
    {
      schema: { body: { type: 'object', properties: fields, required: ['name'], additionalProperties: false } },
    },
    async (req, reply) => {
      try {
        return reply.code(201).send(createProfile(db, req.body));
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: 'name_taken' });
        throw err;
      }
    },
  );

  api.patch<{ Params: { id: number }; Body: ProfileInput }>(
    '/profiles/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', properties: fields, additionalProperties: false },
      },
    },
    async (req, reply) => {
      if (!getProfile(db, req.params.id)) return reply.code(404).send({ error: 'not_found' });
      try {
        return updateProfile(db, req.params.id, req.body);
      } catch (err) {
        if (isUniqueViolation(err)) return reply.code(409).send({ error: 'name_taken' });
        throw err;
      }
    },
  );

  api.delete<{ Params: { id: number } }>('/profiles/:id', { schema: { params: idParams } }, async (req, reply) =>
    deleteProfile(db, req.params.id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not_found' }),
  );
}
