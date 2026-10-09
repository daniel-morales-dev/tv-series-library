import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';

// Serves `rel` from inside `baseDir` and nowhere else: only listed extensions, no `..`, and symlinks
// are resolved so they cannot lead out of the folder. Everything else is a 404.
export async function sendFile(
  reply: FastifyReply,
  baseDir: string,
  rel: string,
  types: Record<string, string>,
  cacheControl: string | ((ext: string) => string),
): Promise<FastifyReply> {
  const notFound = () => reply.code(404).send({ error: 'not_found' });
  const ext = extname(rel).toLowerCase();
  const type = types[ext];
  if (!type || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return notFound();
  const base = resolve(baseDir);
  const file = resolve(base, rel);
  if (!file.startsWith(base + sep)) return notFound();
  try {
    const real = await realpath(file);
    if (!real.startsWith((await realpath(base)) + sep) || !(await stat(real)).isFile()) return notFound();
    const cache = typeof cacheControl === 'function' ? cacheControl(ext) : cacheControl;
    return reply.type(type).header('cache-control', cache).send(createReadStream(real));
  } catch {
    return notFound();
  }
}
