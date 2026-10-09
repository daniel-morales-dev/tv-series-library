import type { FastifyInstance } from 'fastify';
import { sendFile } from './static-file.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

// Serves the built web app; any extensionless path outside /api is a client-side route and gets index.html.
export function webRoutes(app: FastifyInstance, webDir: string) {
  app.setNotFoundHandler((req, reply) => {
    const path = decodeURIComponent(req.url.split('?')[0]!);
    if (req.method !== 'GET' || path === '/api' || path.startsWith('/api/')) {
      return reply.code(404).send({ message: `Route ${req.method}:${path} not found`, error: 'Not Found', statusCode: 404 });
    }
    const last = path.slice(path.lastIndexOf('/') + 1);
    const rel = last.includes('.') ? path.slice(1) : 'index.html';
    const cache = (ext: string) => (path.startsWith('/assets/') && ext !== '.html' ? 'public, max-age=31536000, immutable' : 'no-cache');
    return sendFile(reply, webDir, rel, TYPES, cache);
  });
}
