import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeChapters } from '../src/modules/catalog/chapters.ts';
import { ffprobe } from '../src/modules/ingest/probe.ts';
import { createRunFfmpeg, ffmpegBin, ffprobeBin } from '../src/modules/processing/ffmpeg.ts';
import { findWriters } from '../src/modules/processing/proc.ts';
import { createShutdown } from '../src/shutdown.ts';

// Windows portability: /proc is Linux-only, ffmpeg lives next to the app (env override), and there is
// no ffmpeg adoption outside Linux. None of this needs a real Windows box: the platform is injected or
// the fake binaries are plain node scripts.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeBin(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tvlib-win-'));
  roots.push(dir);
  const bin = join(dir, name);
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('proc on Windows', () => {
  it('findWriters scans nothing outside Linux instead of failing on a missing /proc', () => {
    expect(findWriters('/nonexistent/hls', 'win32')).toEqual([]);
    expect(findWriters('/nonexistent/hls', 'darwin')).toEqual([]);
    if (process.platform === 'linux') expect(findWriters('/nonexistent/hls')).toEqual([]);
  });
});

describe('ffmpeg binary resolution', () => {
  it('FFMPEG_BIN/FFPROBE_BIN override the bare names; empty values fall back', () => {
    expect(ffmpegBin({})).toBe('ffmpeg');
    expect(ffprobeBin({})).toBe('ffprobe');
    expect(ffmpegBin({ FFMPEG_BIN: 'C:\\sala\\ffmpeg\\bin\\ffmpeg.exe' })).toBe('C:\\sala\\ffmpeg\\bin\\ffmpeg.exe');
    expect(ffprobeBin({ FFPROBE_BIN: '/opt/ffprobe' })).toBe('/opt/ffprobe');
    expect(ffmpegBin({ FFMPEG_BIN: '' })).toBe('ffmpeg');
    expect(ffprobeBin({ FFPROBE_BIN: '' })).toBe('ffprobe');
  });

  it('createRunFfmpeg without an explicit bin spawns FFMPEG_BIN', async () => {
    const bin = fakeBin('fake-ffmpeg', 'process.exit(0);');
    const previous = process.env.FFMPEG_BIN;
    process.env.FFMPEG_BIN = bin;
    try {
      await createRunFfmpeg()(['x']);
    } finally {
      if (previous === undefined) delete process.env.FFMPEG_BIN;
      else process.env.FFMPEG_BIN = previous;
    }
  });

  it('ffprobe (ingest) runs FFPROBE_BIN and parses its JSON', async () => {
    const bin = fakeBin(
      'fake-ffprobe',
      `process.stdout.write(JSON.stringify({
  format: { duration: '90.5' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'spa' } },
  ],
  chapters: [{ start_time: '0', end_time: '12.5', tags: { title: 'Inicio' } }],
}));`,
    );
    const previous = process.env.FFPROBE_BIN;
    process.env.FFPROBE_BIN = bin;
    try {
      const result = await ffprobe('/media/x.mkv');
      expect(result.durationS).toBe(90.5);
      expect(result.audio).toEqual([{ index: 1, codec: 'aac', language: 'spa', title: null, channels: 2 }]);
      expect(result.chapters).toEqual([{ startS: 0, endS: 12.5, title: 'Inicio' }]);
    } finally {
      if (previous === undefined) delete process.env.FFPROBE_BIN;
      else process.env.FFPROBE_BIN = previous;
    }
  });

  it('probeChapters runs FFPROBE_BIN and parses its JSON', async () => {
    const bin = fakeBin('fake-ffprobe', `process.stdout.write(JSON.stringify({ chapters: [{ start_time: '1', end_time: '2', tags: { title: 'Cap' } }] }));`);
    const previous = process.env.FFPROBE_BIN;
    process.env.FFPROBE_BIN = bin;
    try {
      expect(await probeChapters('/media/x.mkv')).toEqual([{ startS: 1, endS: 2, title: 'Cap' }]);
    } finally {
      if (previous === undefined) delete process.env.FFPROBE_BIN;
      else process.env.FFPROBE_BIN = previous;
    }
  });
});

describe('shutdown on Windows', () => {
  it('kills the ffmpeg children: there is no adoption without /proc', async () => {
    const worker = { stop: vi.fn() };
    await createShutdown({ app: { close: async () => {} }, worker, exit: () => {}, platform: 'win32' })();
    expect(worker.stop).toHaveBeenCalledWith({ killChildren: true });
  });

  it('keeps the POSIX behavior: children survive for the next server to adopt', async () => {
    const worker = { stop: vi.fn() };
    await createShutdown({ app: { close: async () => {} }, worker, exit: () => {}, platform: 'linux' })();
    expect(worker.stop).toHaveBeenCalledWith({ killChildren: false });
  });
});
