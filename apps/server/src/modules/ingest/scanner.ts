import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const VIDEO = /\.(mkv|mp4|m4v|avi|webm|mov|ts)$/i;
/** The only folders the library reads and watches (never `.sala/`). */
export const ROOTS = ['shows', 'films'];

export interface VideoFile {
  /** Relative to the content dir, `/` separated. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

export async function listVideos(contentDir: string): Promise<VideoFile[]> {
  const out: VideoFile[] = [];
  for (const root of ROOTS) {
    let entries;
    try {
      entries = await readdir(join(contentDir, root), { recursive: true, withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !VIDEO.test(entry.name)) continue;
      const abs = join(entry.parentPath, entry.name);
      const info = await stat(abs).catch(() => null); // may vanish mid-scan
      if (!info) continue;
      out.push({ rel: relative(contentDir, abs).split('\\').join('/'), abs, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// The folder a show file belongs to; files directly under shows/ get a virtual folder from their parsed name.
export function showDirKey(rel: string, show: string): string {
  const parts = rel.split('/');
  return parts.length >= 3 ? parts.slice(0, 2).join('/') : `shows/${show}`;
}
