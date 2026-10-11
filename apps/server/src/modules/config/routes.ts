import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { candidateRoots, findMovedLibrary } from '../../config/relocate.ts';
import { configStatus, resolveContentDir, resolveTmdbToken, setContentDir, setTmdbToken } from '../../config/config.ts';
import { TmdbHttpError, createTmdbClient } from '../ingest/tmdb.ts';

export interface ConfigRoutesDeps {
  /** Server's resolved content dir (env → config.json → default); used for suggestedDefault. */
  currentContentDir?: () => string;
  /** Called after a successful PUT so the ingestor can start or kick a scan. */
  onReady?: (contentDir: string) => void;
  /** T58: called after a token is saved so pending metadata is retried right away; absent = next scan (≤5 min). */
  onTmdbTokenSaved?: () => void;
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

const tmdbTokenBody = {
  type: 'object',
  properties: {
    token: { type: 'string' },
  },
  required: ['token'],
  additionalProperties: false,
} as const;

export function configRoutes(api: FastifyInstance, deps: ConfigRoutesDeps = {}): void {
  const currentContentDir = deps.currentContentDir ?? (() => resolveContentDir());

  api.get('/config', async () => {
    const status = configStatus(currentContentDir());
    // T58: only the boolean travels — the token itself is never returned to the browser.
    return { ...status, tmdbConfigured: resolveTmdbToken() !== null };
  });

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

  // T58: save (trimmed) or clear (empty string) the TMDB token; the retry hook runs the pending-metadata pass now.
  api.put<{ Body: { token: string } }>(
    '/config/tmdb-token',
    { schema: { body: tmdbTokenBody } },
    async (req, reply) => {
      const result = setTmdbToken(req.body.token);
      if (!result.ok) return reply.code(409).send({ error: 'no_config', message: 'Configura primero la carpeta de la biblioteca.' });
      if (result.tmdbConfigured) deps.onTmdbTokenSaved?.();
      return {
        ok: true,
        tmdbConfigured: result.tmdbConfigured,
        message: result.tmdbConfigured
          ? deps.onTmdbTokenSaved
            ? 'Token guardado. Se buscarán ahora los metadatos pendientes.'
            : 'Token guardado. Los metadatos pendientes se buscarán en el próximo escaneo (hasta 5 minutos).'
          : 'Token eliminado. La ingesta seguirá sin conexión a TMDB.',
      };
    },
  );

  // T58: cheap liveness check for a token before (or after) saving it; never stores anything.
  api.post<{ Body: { token: string } }>(
    '/config/tmdb-token/test',
    { schema: { body: tmdbTokenBody } },
    async (req, reply) => {
      const token = req.body.token.trim() || resolveTmdbToken();
      if (!token) return reply.code(400).send({ error: 'token_required', message: 'Escribe un token antes de probarlo.' });
      try {
        await createTmdbClient(token).searchTv('test');
        return { ok: true, message: 'Token válido. TMDB respondió correctamente.' };
      } catch (err) {
        if (err instanceof TmdbHttpError && err.status === 401)
          return reply
            .code(401)
            .send({ ok: false, error: 'invalid_token', message: 'Token inválido. Verifica que sea el «Read Access Token» de tu cuenta de TMDB.' });
        return reply
          .code(502)
          .send({ ok: false, error: 'tmdb_unreachable', message: 'No se pudo conectar con TMDB. Revisa tu conexión e inténtalo de nuevo.' });
      }
    },
  );
}
