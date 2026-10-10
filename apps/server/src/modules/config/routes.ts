import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { candidateRoots, findMovedLibrary } from '../../config/relocate.ts';
import { configStatus, resolveContentDir, setContentDir } from '../../config/config.ts';

export interface ConfigRoutesDeps {
  /** Server's resolved content dir (env → config.json → default); used for suggestedDefault. */
  currentContentDir?: () => string;
  /** Called after a successful PUT so the ingestor can start or kick a scan. */
  onReady?: (contentDir: string) => void;
  /** Mount parents scanned for a moved library (T22c); defaults to the platform's removable-media locations. */
  mountRoots?: () => string[];
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

  // Suggestions only: the user accepts one with the normal PUT. Nothing is switched, created or written here.
  api.get('/config/candidates', async () => {
    const status = configStatus(currentContentDir());
    if (status.status !== 'missing' || !status.libraryId) return { candidates: [] };
    const roots = deps.mountRoots?.() ?? candidateRoots(status.contentDir);
    const paths = findMovedLibrary({ libraryId: status.libraryId, roots, exclude: status.contentDir });
    return { candidates: paths.map((path) => ({ path, label: basename(path) })) };
  });

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
