import { createHash } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DedupeResult {
  files: number;
  /** Files now sharing the store copy (or that would, in a dry run). */
  linked: number;
  /** Files left as ordinary copies because the filesystem could not hardlink. */
  skipped: number;
  /** Bytes freed by pointing a file at an existing store copy. */
  savedBytes: number;
}

type Link = (existing: string, target: string) => Promise<void>;

// Hardlinks each font of one package folder to `<store>/<sha256>`. Players still read ordinary files, so existing
// packages keep working; where hardlinks are unavailable (exFAT) the file simply stays a plain copy.
// ponytail: hardlinks over a manifest; the stream endpoint and old packages stay untouched. Add a manifest only for a filesystem without links.
export async function dedupeFontsDir(
  fontsDir: string,
  storeDir: string,
  opts: { dryRun?: boolean; link?: Link; /** Hashes a dry run pretends are already stored; share it across calls. */ planned?: Set<string> } = {},
): Promise<DedupeResult> {
  const doLink = opts.link ?? link;
  const result: DedupeResult = { files: 0, linked: 0, skipped: 0, savedBytes: 0 };
  const entries = await readdir(fontsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    result.files++;
    const file = join(fontsDir, entry.name);
    const st = await stat(file);
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    const stored = join(storeDir, hash);
    const inStore = await stat(stored).catch(() => null);
    if (inStore && inStore.ino === st.ino && inStore.dev === st.dev) continue;
    if (inStore && inStore.size !== st.size) continue; // not the content the name promises: never trust it
    if (opts.dryRun) {
      const planned = opts.planned ?? new Set<string>();
      result.linked++;
      if (inStore || planned.has(hash)) result.savedBytes += st.size;
      planned.add(hash);
      continue;
    }
    try {
      if (!inStore) {
        await mkdir(storeDir, { recursive: true });
        await doLink(file, stored); // the first copy becomes the store entry
      } else {
        const tmp = `${file}.lnk`;
        await rm(tmp, { force: true });
        await doLink(stored, tmp);
        await rename(tmp, file); // atomic swap: the font is never missing
        result.savedBytes += st.size;
      }
      result.linked++;
    } catch {
      result.skipped++;
    }
  }
  return result;
}
