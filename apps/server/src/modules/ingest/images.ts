import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TmdbClient } from './tmdb.ts';

const CONCURRENCY = 4;
const SAFE_PATH = /^\/[\w.-]+$/;

export type ImageWant = readonly [size: string, path: string | null | undefined];

// Downloads each image once to DATA_DIR/images/<size>/<file>. A 404 leaves the image out;
// any other failure throws so the metadata import is retried later instead of saving holes.
export async function saveImages(
  tmdb: TmdbClient,
  dataDir: string,
  wants: ImageWant[],
): Promise<(size: string, path: string | null | undefined) => string | null> {
  const saved = new Set<string>();
  const pending = new Map<string, ImageWant>();
  for (const [size, path] of wants) {
    if (path && SAFE_PATH.test(path)) pending.set(`${size}${path}`, [size, path]);
  }
  const jobs = [...pending.entries()];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(
      jobs.slice(i, i + CONCURRENCY).map(async ([rel, [size, path]]) => {
        const file = join(dataDir, 'images', rel);
        if (!existsSync(file)) {
          const bytes = await tmdb.image(size, path!);
          if (!bytes) return;
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(`${file}.part`, bytes);
          renameSync(`${file}.part`, file);
        }
        saved.add(rel);
      }),
    );
  }
  return (size, path) => (path && saved.has(`${size}${path}`) ? `${size}${path}` : null);
}
