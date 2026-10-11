import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprint } from '../src/library/fingerprint.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sala-fingerprint-'));
  dirs.push(dir);
  return dir;
}
function write(dir: string, name: string, content: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
function pattern(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) % 256;
  return buf;
}
const sha1 = (chunks: Buffer[]) => createHash('sha1').update(Buffer.concat(chunks)).digest('hex');

describe('fingerprint', () => {
  it('hashes the whole file when it is smaller than one block', async () => {
    const dir = tmp();
    const content = Buffer.from('short file');
    const path = write(dir, 'a.mkv', content);
    expect(await fingerprint(path)).toBe(`${content.length}-${sha1([content])}`);
  });

  it('reads an exactly-one-block file once, without hashing any byte twice', async () => {
    const dir = tmp();
    const content = pattern(64 * 1024);
    const path = write(dir, 'b.mkv', content);
    expect(await fingerprint(path)).toBe(`${content.length}-${sha1([content])}`);
  });

  it('hashes the first, middle and last blocks, leaving the gaps alone', async () => {
    const dir = tmp();
    const content = pattern(200_000);
    const path = write(dir, 'c.mkv', content);
    const middle = Math.floor(content.length / 2);
    const blocks = [
      content.subarray(0, 64 * 1024),
      content.subarray(middle - 32 * 1024, middle + 32 * 1024),
      content.subarray(content.length - 64 * 1024),
    ];
    const fp = await fingerprint(path);
    expect(fp).toBe(`${content.length}-${sha1(blocks)}`);

    // A byte outside the hashed blocks (the gap before the middle one) changes nothing...
    const inGap = Buffer.from(content);
    inGap[66_000] = inGap[66_000]! ^ 0xff;
    expect(await fingerprint(write(dir, 'c-gap.mkv', inGap))).toBe(fp);

    // ...while a byte inside the middle block does.
    const inMiddle = Buffer.from(content);
    inMiddle[middle] = inMiddle[middle]! ^ 0xff;
    expect(await fingerprint(write(dir, 'c-middle.mkv', inMiddle))).not.toBe(fp);
  });

  it('is deterministic across runs and identical copies', async () => {
    const dir = tmp();
    const content = pattern(150_000);
    const one = write(dir, 'd.mkv', content);
    expect(await fingerprint(one)).toBe(await fingerprint(one));
    expect(await fingerprint(one)).toBe(await fingerprint(write(dir, 'e.mkv', content)));
    expect(await fingerprint(one)).not.toBe(await fingerprint(write(dir, 'f.mkv', pattern(150_001))));
  });

  it('returns null for an unreadable file instead of throwing', async () => {
    const dir = tmp();
    expect(await fingerprint(join(dir, 'absent.mkv'))).toBeNull();
    const asDir = join(dir, 'folder.mkv');
    mkdirSync(asDir);
    expect(await fingerprint(asDir)).toBeNull();
  });
});
