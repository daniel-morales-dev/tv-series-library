import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { get } from '../src/db/sql.ts';
import type { RunFfmpeg } from '../src/modules/processing/ffmpeg.ts';
import { type Plan, type StreamInfo } from '../src/modules/processing/plan.ts';
import { InvalidPackageError, buildMaster, processMedia, validatePackage } from '../src/modules/processing/process.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tvlib-hardening-'));
  roots.push(dir);
  return dir;
}

const INFO: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le' },
  audio: [{ index: 1, codec: 'flac', language: 'jpn', title: null, channels: 2 }],
  subtitles: [],
  attachments: [],
};

const VALID_VIDEO = '#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:6.006000,\nseg_00000.m4s\n';
// ffmpeg's finished master: rendition, variant tag, playlist URI, trailing blank line.
const MASTER_COMPLETE =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_1",DEFAULT=YES,LANGUAGE="jpn",URI="a0/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=211200,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"\nv/index.m3u8\n\n';
// The truncated master the incident published: headers and the audio rendition only.
const MASTER_PHASE1 =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_1",DEFAULT=YES,LANGUAGE="jpn",URI="a0/index.m3u8"\n';
// Ends on a playlist URI but still has no variant tag: the strict gate must skip it too.
const MASTER_NO_VARIANT = MASTER_PHASE1 + 'v/index.m3u8\n';

const mainOut = (args: string[]) => dirname(dirname(args.at(-1)!));

describe('strict mid-run master naming', () => {
  it('skips an incomplete master and names the renditions once it is complete', async () => {
    const dir = tempRoot();
    mkdirSync(join(dir, 'content'), { recursive: true });
    writeFileSync(join(dir, 'content/a.mkv'), 'x');
    const seen: string[] = [];
    const run: RunFfmpeg = async (args, o) => {
      if (!args.includes('-var_stream_map')) return;
      const out = mainOut(args);
      for (const master of [MASTER_PHASE1, MASTER_NO_VARIANT, MASTER_COMPLETE]) {
        writeFileSync(join(out, 'master.m3u8'), master);
        o?.onProgress?.(10);
        await new Promise((r) => setTimeout(r, 50));
        seen.push(readFileSync(join(out, 'master.m3u8'), 'utf8'));
      }
      writeFileSync(join(out, 'v/index.m3u8'), VALID_VIDEO);
      writeFileSync(join(out, 'a0/index.m3u8'), VALID_VIDEO);
    };
    await processMedia(
      { dataDir: join(dir, 'data'), contentDir: join(dir, 'content'), runFfmpeg: run, probeStreams: async () => INFO },
      { id: 7, path: 'a.mkv' },
    );
    expect(seen[0]).toContain('NAME="audio_1"');
    expect(seen[1]).toContain('NAME="audio_1"');
    expect(seen[2]).toContain('NAME="jpn"');
  });
});

// ffmpeg 6.1.1 writes a master with only the #EXT-X-MEDIA audio line for sources without per-stream
// bit_rate metadata; the published master must still be complete.
describe('audio-only ffmpeg master', () => {
  it('publishes a master with the variant tag built from the plan', async () => {
    const dir = tempRoot();
    mkdirSync(join(dir, 'content'), { recursive: true });
    writeFileSync(join(dir, 'content/a.mkv'), 'x');
    const run: RunFfmpeg = async (args, o) => {
      if (!args.includes('-var_stream_map')) return;
      const out = mainOut(args);
      writeFileSync(join(out, 'master.m3u8'), MASTER_PHASE1);
      writeFileSync(join(out, 'v/index.m3u8'), VALID_VIDEO);
      writeFileSync(join(out, 'v/seg_00000.m4s'), 'v');
      writeFileSync(join(out, 'a0/index.m3u8'), VALID_VIDEO);
      writeFileSync(join(out, 'a0/seg_00000.m4s'), 'a');
      o?.onProgress?.(50);
    };
    await processMedia(
      { dataDir: join(dir, 'data'), contentDir: join(dir, 'content'), runFfmpeg: run, probeStreams: async () => INFO },
      { id: 42, path: 'a.mkv' },
    );
    const master = readFileSync(join(dir, 'data', 'hls', '42', 'master.m3u8'), 'utf8');
    expect(master).toContain('#EXT-X-STREAM-INF:');
    expect(master).toContain('v/index.m3u8');
  });
});

describe('buildMaster', () => {
  it('writes the master from the plan and the segments on disk', async () => {
    const dir = tempRoot();
    for (const rendition of ['v', 'a0', 'a1']) mkdirSync(join(dir, rendition), { recursive: true });
    writeFileSync(join(dir, 'v/seg_00000.m4s'), 'x'.repeat(1000));
    writeFileSync(join(dir, 'a0/seg_00000.m4s'), 'x'.repeat(300));
    writeFileSync(join(dir, 'a1/seg_00000.m4s'), 'x'.repeat(200));
    const plan: Plan = {
      video: { index: 0, mode: 'x264' },
      audio: [
        { index: 1, codec: 'flac', language: 'jpn', title: null, channels: 2, n: 0, mode: 'aac', bitrate: '192k', playlist: 'a0/index.m3u8' },
        { index: 2, codec: 'aac', language: null, title: 'Dub', channels: 2, n: 1, mode: 'copy', bitrate: null, playlist: 'a1/index.m3u8' },
      ],
      subtitles: [],
      fonts: [],
    };
    await buildMaster(dir, plan, 10);
    // 1500 segment bytes over 10 s: ceil((1000 + 300 + 200) * 8 / 10), default names on the first track only.
    expect(readFileSync(join(dir, 'master.m3u8'), 'utf8')).toBe(
      '#EXTM3U\n#EXT-X-VERSION:7\n' +
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="jpn",DEFAULT=YES,LANGUAGE="jpn",URI="a0/index.m3u8"\n' +
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="Dub",URI="a1/index.m3u8"\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1200,AUDIO="group_aud"\n' +
        'v/index.m3u8\n',
    );
  });
});

describe('processMedia validation', () => {
  it('rejects a package without a video playlist and never publishes it', async () => {
    const dir = tempRoot();
    mkdirSync(join(dir, 'content'), { recursive: true });
    writeFileSync(join(dir, 'content/a.mkv'), 'x');
    const run: RunFfmpeg = async (args, o) => {
      if (!args.includes('-var_stream_map')) return;
      const out = mainOut(args);
      writeFileSync(join(out, 'master.m3u8'), MASTER_PHASE1);
      writeFileSync(join(out, 'a0/index.m3u8'), VALID_VIDEO);
      o?.onProgress?.(50);
    };
    const deps = { dataDir: join(dir, 'data'), contentDir: join(dir, 'content'), runFfmpeg: run, probeStreams: async () => INFO };
    await expect(processMedia(deps, { id: 9, path: 'a.mkv' })).rejects.toThrow(InvalidPackageError);
    expect(existsSync(join(dir, 'data', 'hls', '9'))).toBe(false);
    expect(existsSync(join(dir, 'data', 'hls', '9.tmp'))).toBe(false);
  });
});

describe('validatePackage', () => {
  function packageDir(master: string, video = VALID_VIDEO): string {
    const dir = tempRoot();
    mkdirSync(join(dir, 'v'), { recursive: true });
    mkdirSync(join(dir, 'a0'), { recursive: true });
    writeFileSync(join(dir, 'master.m3u8'), master);
    writeFileSync(join(dir, 'v/index.m3u8'), video);
    writeFileSync(join(dir, 'a0/index.m3u8'), '#EXTM3U\n');
    return dir;
  }

  it('accepts a complete package', async () => {
    await expect(validatePackage(packageDir(MASTER_COMPLETE))).resolves.toBeUndefined();
  });

  it('rejects a master without the variant tag', async () => {
    await expect(validatePackage(packageDir(MASTER_PHASE1))).rejects.toThrow(InvalidPackageError);
  });

  it('rejects a master referencing a missing playlist', async () => {
    const dir = packageDir(MASTER_COMPLETE);
    rmSync(join(dir, 'a0/index.m3u8'));
    await expect(validatePackage(dir)).rejects.toThrow(InvalidPackageError);
  });

  it('rejects a video playlist without segments', async () => {
    await expect(validatePackage(packageDir(MASTER_COMPLETE, '#EXTM3U\n#EXT-X-VERSION:7\n'))).rejects.toThrow(
      InvalidPackageError,
    );
  });
});

describe('worker reprocess', () => {
  function workerEnv(run: RunFfmpeg) {
    const dir = tempRoot();
    mkdirSync(join(dir, 'content'), { recursive: true });
    writeFileSync(join(dir, 'content/a.mkv'), 'x');
    const { db } = setup();
    const titleId = addTitle(db, 'T', { kind: 'anime' });
    const id = addFile(db, titleId, { status: 'pending' });
    db.prepare('UPDATE media_files SET path = ?, duration_s = 100 WHERE id = ?').run('a.mkv', id);
    enqueue(db, id);
    const worker = createWorker({
      db,
      dataDir: join(dir, 'data'),
      contentDir: join(dir, 'content'),
      runFfmpeg: run,
      probeStreams: async () => INFO,
    });
    return { db, dir, worker, id };
  }

  const file = (db: ReturnType<typeof setup>['db'], id: number) =>
    get<{ status: string; error: string | null }>(db, 'SELECT status, error FROM media_files WHERE id = ?', id)!;

  it('reprocesses a truncated package once, then marks the job as error', async () => {
    const runs: string[] = [];
    const run: RunFfmpeg = async (args, o) => {
      if (!args.includes('-var_stream_map')) return;
      runs.push(args.at(-1)!);
      writeFileSync(join(mainOut(args), 'master.m3u8'), MASTER_PHASE1);
      o?.onProgress?.(50);
    };
    const e = workerEnv(run);
    await e.worker.drain();

    expect(runs).toHaveLength(2);
    expect(file(e.db, e.id).status).toBe('error');
    expect(file(e.db, e.id).error).toContain('invalid HLS package');
    expect(get<{ status: string }>(e.db, 'SELECT status FROM jobs WHERE media_file_id = ?', e.id)!.status).toBe('error');
    expect(existsSync(join(e.dir, 'data', 'hls', String(e.id)))).toBe(false);
    expect(existsSync(join(e.dir, 'data', 'hls', `${e.id}.tmp`))).toBe(false);
  });

  it('publishes the package when the one reprocess succeeds', async () => {
    const runs: number[] = [];
    const run: RunFfmpeg = async (args, o) => {
      if (!args.includes('-var_stream_map')) return;
      runs.push(1);
      const out = mainOut(args);
      if (runs.length === 1) {
        writeFileSync(join(out, 'master.m3u8'), MASTER_PHASE1);
      } else {
        writeFileSync(join(out, 'master.m3u8'), MASTER_COMPLETE);
        writeFileSync(join(out, 'v/index.m3u8'), VALID_VIDEO);
        writeFileSync(join(out, 'a0/index.m3u8'), VALID_VIDEO);
      }
      o?.onProgress?.(50);
    };
    const e = workerEnv(run);
    await e.worker.drain();

    expect(runs).toHaveLength(2);
    expect(file(e.db, e.id).status).toBe('ready');
    expect(readFileSync(join(e.dir, 'data', 'hls', String(e.id), 'master.m3u8'), 'utf8')).toContain('NAME="jpn"');
  });
});
