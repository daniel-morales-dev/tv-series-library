import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readMarker } from './config.ts';

export interface FindOptions {
  libraryId: string;
  roots: string[];
  /** Path to leave out (the configured folder itself). */
  exclude?: string;
  /** Levels below each root that are inspected (1 = the root's children). */
  maxDepth?: number;
  /** Time budget; the scan stops quietly when it runs out. */
  deadlineMs?: number;
  /** Cap of entries read per directory, so a huge folder cannot stall the scan. */
  maxEntries?: number;
}

/**
 * Read-only, shallow and bounded: returns folders under `roots` whose marker carries `libraryId`.
 * Never writes, never creates a marker; unreadable directories are skipped.
 */
export function findMovedLibrary(options: FindOptions): string[] {
  const { libraryId, exclude, maxDepth = 2, maxEntries = 200 } = options;
  const deadline = Date.now() + (options.deadlineMs ?? 3000);
  const found = new Set<string>();

  const visit = (dir: string, depth: number): void => {
    if (Date.now() > deadline) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .slice(0, maxEntries)
        .map((entry) => entry.name);
    } catch {
      return;
    }
    for (const name of names) {
      if (Date.now() > deadline) return;
      const path = join(dir, name);
      if (path !== exclude && readMarker(path, () => {})?.libraryId === libraryId) found.add(path);
      else if (depth < maxDepth) visit(path, depth + 1);
    }
  };

  for (const root of options.roots) visit(root, 1);
  return [...found];
}

/** Mount parents worth scanning: Linux removable-media locations plus the neighborhood of the configured folder. */
export function candidateRoots(contentDir: string | null, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'linux') return [];
  const user = env.USER || env.LOGNAME;
  const roots = [...(user ? [`/media/${user}`, `/run/media/${user}`] : []), '/mnt'];
  if (contentDir) roots.push(dirname(contentDir));
  return [...new Set(roots)];
}
