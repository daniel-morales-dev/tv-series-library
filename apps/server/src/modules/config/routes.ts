import type { FastifyInstance } from 'fastify';
import { configStatus, resolveContentDir, setContentDir } from '../../config/config.ts';

export interface ConfigRoutesDeps {
  /** Server's resolved content dir (env → config.json → default); used for suggestedDefault. */
  currentContentDir?: () => string;
  /** Called after a successful PUT so the ingestor can start or kick a scan. */
  onReady?: (contentDir: string) => void;
}

const contentDirBody = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    create: { type: 'boolean' },
  },
  required: ['path'],
  additionalProperties: false,
} as const;

export function configRoutes(api: FastifyInstance, deps: ConfigRoutesDeps = {}): void {
  const currentContentDir = deps.currentContentDir ?? (() => resolveContentDir());

  api.get('/config', async () => configStatus(currentContentDir()));

  api.put<{ Body: { path: string; create?: boolean } }>(
    '/config/content-dir',
    { schema: { body: contentDirBody } },
    async (req, reply) => {
      const result = setContentDir(req.body.path, { create: req.body.create ?? false });
      if (!result.ok) return reply.code(400).send({ error: result.error });
      if (result.status.contentDir) deps.onReady?.(result.status.contentDir);
      return result.status;
    },
  );
}
