import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

/** Bytes read at the start, middle and end of a file: enough to tell two episodes apart without reading a whole HDD. */
const BLOCK = 64 * 1024;

/** Byte ranges hashed for a file of `size` bytes, deduped so a small file is never read twice. */
function fingerprintRanges(size: number): { start: number; end: number }[] {
  const middle = Math.floor(size / 2);
  const ranges = [
    { start: 0, end: Math.min(BLOCK, size) },
    { start: Math.max(0, middle - BLOCK / 2), end: Math.min(size, middle + BLOCK / 2) },
    { start: Math.max(0, size - BLOCK), end: size },
  ].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = out.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

/**
 * Content identity of a file: `<size>-<sha1 of its first, middle and last blocks>`. Stable across moves and
 * roots, cheap on spinning disks (at most 192 KiB read). An unreadable file (absent root, permissions) is
 * null, never a throw.
 */
export async function fingerprint(path: string): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const hash = createHash('sha1');
    for (const { start, end } of fingerprintRanges(size)) {
      const block = Buffer.allocUnsafe(end - start);
      let read = 0;
      while (read < block.length) {
        const { bytesRead } = await handle.read(block, read, block.length - read, start + read);
        if (bytesRead === 0) return null; // truncated under us: not a fingerprint we can trust
        read += bytesRead;
      }
      hash.update(block);
    }
    return `${size}-${hash.digest('hex')}`;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
