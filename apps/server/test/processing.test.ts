import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, get } from '../src/db/sql.ts';
import { extractArgs, mainArgs, nameRenditions } from '../src/modules/processing/ffmpeg.ts';
import { type Plan, type StreamInfo, buildPlan } from '../src/modules/processing/plan.ts';
import type { RunFfmpeg } from '../src/modules/processing/ffmpeg.ts';
import { registerFile } from '../src/modules/ingest/register.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const INFO: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le' },
  audio: [
    { index: 1, codec: 'flac', language: 'jpn', title: null, channels: 2 },
    { index: 2, codec: 'aac', language: 'eng', title: 'Dub', channels: 2 },
  ],
  subtitles: [
    { index: 3, codec: 'ass', language: 'eng', title: 'Full' },
    { index: 4, codec: 'hdmv_pgs_subtitle', language: 'spa', title: null },
  ],
  attachments: [{ index: 5, filename: 'Arial.ttf', mimetype: 'application/x-truetype-font' }],
};
const PLAN: Plan = buildPlan(INFO);

// A complete package as ffmpeg leaves it: master with every rendition and the playlists it references.
function writeHlsPackage(out: string) {
  writeFileSync(
    join(out, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:7\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_1",DEFAULT=YES,LANGUAGE="jpn",URI="a0/index.m3u8"\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_2",LANGUAGE="eng",URI="a1/index.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=211200,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"\n' +
      'v/index.m3u8\n\n',
  );
  for (const p of ['v/index.m3u8', 'a0/index.m3u8', 'a1/index.m3u8']) {
    writeFileSync(join(out, p), '#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:6.006000,\nseg_00000.m4s\n');
  }
}

describe('ffmpeg arguments', () => {
  it('builds one HLS run for video and every audio rendition', () => {
    const args = mainArgs(PLAN, '/src.mkv', '/out');
    const joined = args.join(' ');
    expect(joined).toContain('-map 0:0 -map 0:1 -map 0:2');
    expect(joined).toContain('-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p');
    expect(joined).toContain('-c:a:0 aac -b:a:0 192k -ac:a:0 2 -c:a:1 copy');
    expect(joined).toContain('-hls_segment_type fmp4');
    expect(joined).toContain('-hls_time 6');
    expect(args).toContain('-progress');
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe(
      'v:0,agroup:aud,name:v a:0,agroup:aud,name:a0,language:jpn,default:yes a:1,agroup:aud,name:a1,language:eng',
    );
    expect(args.at(-1)).toBe('/out/%v/index.m3u8');
  });

  it('writes a growing event playlist and limits x264 threads', () => {
    const args = mainArgs(PLAN, '/src.mkv', '/out', { threads: 2 });
    expect(args.join(' ')).toContain('-hls_playlist_type event');
    expect(args.join(' ')).toContain('-pix_fmt yuv420p -force_key_frames expr:gte(t,n_forced*2) -threads 2');
    expect(mainArgs(PLAN, '/src.mkv', '/out')).not.toContain('-threads');
  });

  it('copies compatible video', () => {
    const plan = buildPlan({ ...INFO, video: { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p' } });
    expect(mainArgs(plan, '/s', '/o').join(' ')).toContain('-c:v copy');
  });

  it('extracts the vtt and untouched ass, skips unsupported subtitles, and dumps fonts', () => {
    const args = extractArgs(PLAN, '/src.mkv', '/out');
    expect(args.join(' ')).toContain('-dump_attachment:5 /out/fonts/Arial.ttf -i /src.mkv');
    expect(args.join(' ')).toContain('-map 0:3 -c:s webvtt /out/subs/0.vtt -map 0:3 -c:s copy /out/subs/0.ass');
    expect(args.join(' ')).not.toContain('0:4');
  });

  it('gives fonts-only files a throwaway output', () => {
    const args = extractArgs(buildPlan({ ...INFO, subtitles: [] }), '/s', '/o');
    expect(args.slice(-7)).toEqual(['-map', '0:0', '-frames:v', '1', '-f', 'null', '-']);
  });

  it('names renditions after the track title, then the language', () => {
    const master = '#EXT-X-MEDIA:TYPE=AUDIO,NAME="audio_1",URI="a0/index.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="audio_2",URI="a1/index.m3u8"\n';
    expect(nameRenditions(master, PLAN)).toBe(
      '#EXT-X-MEDIA:TYPE=AUDIO,NAME="jpn",URI="a0/index.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="Dub",URI="a1/index.m3u8"\n',
    );
  });
});

function env(runner?: RunFfmpeg, now: () => number = () => 0) {
  const root = mkdtempSync(join(tmpdir(), 'tvlib-proc-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const contentDir = join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  const { db } = setup();
  const titleId = addTitle(db, 'T', { kind: 'anime' });
  const calls: string[][] = [];

  // Fake ffmpeg: the main run writes a master playlist, the extraction run writes what it was asked for.
  const fake: RunFfmpeg = async (args, o) => {
    calls.push(args);
    if (runner) return runner(args, o);
    if (args.includes('-var_stream_map')) {
      const out = dirname(dirname(args.at(-1)!));
      o?.onProgress?.(50);
      writeHlsPackage(out);
    } else {
      for (const a of args) if (/\.(vtt|ass|ttf)$/.test(a)) writeFileSync(a, 'x');
    }
  };
  const worker = createWorker({
    db,
    dataDir,
    contentDir,
    runFfmpeg: fake,
    probeStreams: async () => INFO,
    now,
  });
  const source = (rel = 'a.mkv') => {
    writeFileSync(join(contentDir, rel), 'x');
    const id = addFile(db, titleId, { status: 'pending' });
    db.prepare('UPDATE media_files SET path = ?, duration_s = 100 WHERE id = ?').run(rel, id);
    enqueue(db, id);
    return id;
  };
  const file = (id: number) => get<any>(db, 'SELECT * FROM media_files WHERE id = ?', id);
  const job = (id: number) => get<any>(db, 'SELECT * FROM jobs WHERE media_file_id = ?', id);
  return { db, dataDir, contentDir, worker, source, file, job, calls };
}

describe('worker', () => {
  it('processes a file to ready, publishing the HLS folder and track outputs', async () => {
    const e = env();
    const id = e.source();
    await e.worker.drain();

    const f = e.file(id);
    expect(f).toMatchObject({ status: 'ready', hls_dir: `hls/${id}`, error: null });
    expect(JSON.parse(f.audio_tracks)[0]).toMatchObject({ language: 'jpn', playlist: 'a0/index.m3u8' });
    expect(JSON.parse(f.subtitle_tracks)).toMatchObject([
      { supported: true, vtt: 'subs/0.vtt', ass: 'subs/0.ass' },
      { supported: false, vtt: null, ass: null },
    ]);
    expect(e.job(id)).toMatchObject({ status: 'done', progress: 1 });
    const dir = join(e.dataDir, 'hls', String(id));
    expect(readFileSync(join(dir, 'master.m3u8'), 'utf8')).toContain('NAME="jpn"');
    expect(existsSync(join(dir, 'subs/0.vtt')) && existsSync(join(dir, 'subs/0.ass')) && existsSync(join(dir, 'fonts/Arial.ttf'))).toBe(true);
    expect(existsSync(`${dir}.tmp`)).toBe(false);
  });

  it('records ffmpeg failures, cleans the temporary folder and keeps going with the next job', async () => {
    const calls: number[] = [];
    const e = env(async (args) => {
      calls.push(1);
      if (calls.length === 1) {
        writeFileSync(join(dirname(dirname(args.at(-1)!)), 'partial'), 'x');
        throw new Error('ffmpeg exited with 1: Invalid data');
      }
      if (args.includes('-var_stream_map')) writeHlsPackage(dirname(dirname(args.at(-1)!)));
    });
    const bad = e.source('bad.mkv');
    const good = e.source('good.mkv');
    await e.worker.drain();

    expect(e.file(bad)).toMatchObject({ status: 'error' });
    expect(e.file(bad).error).toContain('Invalid data');
    expect(e.job(bad).status).toBe('error');
    expect(e.file(good).status).toBe('ready');
    expect(readdirSync(join(e.dataDir, 'hls'))).toEqual([String(good)]);
  });

  it('fails without retrying when the source file is gone', async () => {
    const e = env();
    const id = e.source();
    rmSync(join(e.contentDir, 'a.mkv'));
    await e.worker.drain();
    expect(e.file(id)).toMatchObject({ status: 'error' });
    expect(e.file(id).error).toContain('source file not found');
    expect(e.calls).toHaveLength(0);
  });

  it('throttles progress writes to one per second', async () => {
    let t = 0;
    const seen: number[] = [];
    let db!: ReturnType<typeof setup>['db'];
    const e = env(async (args, o) => {
      if (!args.includes('-var_stream_map')) return;
      for (const [at, seconds] of [[0, 10], [400, 20], [800, 30], [1000, 40]]) {
        t = at;
        o?.onProgress?.(seconds);
        seen.push(get<{ progress: number }>(db, 'SELECT progress FROM jobs')!.progress);
      }
      writeHlsPackage(dirname(dirname(args.at(-1)!)));
    }, () => t);
    db = e.db;
    const id = e.source();
    await e.worker.drain();
    // 100 s source: 10 s and 40 s are written (x0.99); 20 s and 30 s fall inside the same second.
    expect(seen).toEqual([0.099, 0.099, 0.099, 0.396]);
    expect(e.job(id).progress).toBe(1);
  });
});

describe('play while processing', () => {
  const outDir = (args: string[]) => dirname(dirname(args.at(-1)!));

  it('extracts subtitles before the video run and names the audio tracks as soon as the master exists', async () => {
    let namedMidRun = '';
    const e = env(async (args, o) => {
      if (!args.includes('-var_stream_map')) return void args.forEach((a) => /\.(vtt|ass|ttf)$/.test(a) && writeFileSync(a, 'x'));
      const out = outDir(args);
      writeHlsPackage(out);
      o?.onProgress?.(10);
      await new Promise((r) => setTimeout(r, 50));
      namedMidRun = readFileSync(join(out, 'master.m3u8'), 'utf8');
      expect(existsSync(join(out, 'subs/0.vtt'))).toBe(true);
    });
    const id = e.source();
    await e.worker.drain();
    expect(namedMidRun).toContain('NAME="jpn"');
    expect(e.calls.map((a) => a.includes('-var_stream_map'))).toEqual([false, true]);
    expect(readFileSync(join(e.dataDir, 'hls', String(id), 'master.m3u8'), 'utf8')).toContain('NAME="jpn"');
  });

  it('stores the planned tracks before the video run, so a player can use them while processing', async () => {
    let db!: ReturnType<typeof setup>['db'];
    let during: any;
    const e = env(async (args) => {
      if (!args.includes('-var_stream_map')) return void args.forEach((a) => /\.(vtt|ass|ttf)$/.test(a) && writeFileSync(a, 'x'));
      during = get<any>(db, 'SELECT status, subtitle_tracks, audio_tracks FROM media_files');
      writeHlsPackage(outDir(args));
    });
    db = e.db;
    e.source();
    await e.worker.drain();
    expect(during.status).toBe('processing');
    expect(JSON.parse(during.subtitle_tracks)[0]).toMatchObject({ supported: true, vtt: 'subs/0.vtt' });
    expect(JSON.parse(during.audio_tracks)[0]).toMatchObject({ language: 'jpn', playlist: 'a0/index.m3u8' });
  });

  it('requeues the running job of another file, restarting it, when a play request arrives', async () => {
    let release!: () => void;
    const started: string[] = [];
    const e = env(async (args, o) => {
      const out = outDir(args);
      if (!args.includes('-var_stream_map')) return;
      started.push(out);
      if (started.length === 1) {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          o?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      writeHlsPackage(out);
    });
    const slow = e.source('slow.mkv');
    const fast = e.source('fast.mkv');
    e.worker.kick();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    enqueue(e.db, fast, true);
    e.worker.prioritize(fast);
    await vi.waitFor(() => expect(e.file(fast).status).toBe('ready'));
    expect(started[1]).toContain(`${fast}.tmp`);
    expect(e.job(slow)).toMatchObject({ status: 'done' }); // restarted from the queue and finished afterwards
    expect(started).toHaveLength(3);
    expect(e.file(slow).status).toBe('ready');
    release?.();
  });

  it('does nothing when the requested file is already running', async () => {
    const e = env(async (args, o) => {
      if (!args.includes('-var_stream_map')) return;
      await new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const id = e.source();
    e.worker.kick();
    await vi.waitFor(() => expect(e.calls.length).toBeGreaterThan(0));
    e.worker.prioritize(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(e.job(id).status).toBe('running');
    e.worker.stop();
  });
});

describe('restart recovery', () => {
  it('requeues a job interrupted mid-run and finishes it on start', async () => {
    const e = env();
    const id = e.source();
    e.db.exec("UPDATE jobs SET status = 'running', progress = 0.4"); // as left by a crash
    e.db.exec("UPDATE media_files SET status = 'processing'");
    e.worker.start();
    await e.worker.drain();
    e.worker.stop();
    expect(e.file(id).status).toBe('ready');
    expect(all(e.db, 'SELECT status FROM jobs')).toEqual([{ status: 'done' }]);
  });
});

describe('ingestion', () => {
  it('queues a process job for every registered file', () => {
    const { db } = setup();
    const titleId = addTitle(db, 'T');
    const probe = { durationS: 10, audio: [], subtitles: [] };
    registerFile(db, { rel: 'a.mkv', size: 1, probe }, { titleId, episodeId: null, extraLabel: null, parsedSeason: null, parsedNumber: null });
    expect(all(db, 'SELECT type, status, media_file_id FROM jobs')).toEqual([{ type: 'process', status: 'queued', media_file_id: 1 }]);
    expect(get(db, 'SELECT status FROM media_files')).toEqual({ status: 'pending' });
  });
});
