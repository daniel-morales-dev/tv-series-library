import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { configStatus, libraryDiskPresent, readUserConfig, setContentDir, writeMarker, writeUserConfig } from '../src/config/config.ts';
import { resolveDataPaths } from '../src/config/paths.ts';
import { get } from '../src/db/sql.ts';
import type { RunFfmpeg } from '../src/modules/processing/ffmpeg.ts';
import type { StreamInfo } from '../src/modules/processing/plan.ts';
import { enqueue } from '../src/modules/processing/queue.ts';
import { createWorker } from '../src/modules/processing/worker.ts';
import { addFile, addTitle, setup } from './helpers.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tvlib-disk-'));
  roots.push(d);
  return d;
};

describe('library marker guardian (T47d)', () => {
  it('reports missing for an empty mount point and never creates the marker, .sala or config changes', () => {
    const cfg = join(tmp(), 'cfg');
    const media = tmp();
    writeUserConfig({ contentDir: media, libraryId: 'lib-x' }, cfg);
    const before = readFileSync(join(cfg, 'config.json'), 'utf8');
    expect(configStatus(media, { dir: cfg })).toEqual({ status: 'missing', contentDir: media, libraryId: 'lib-x', suggestedDefault: media });
    expect(existsSync(join(media, '.sala-library.json'))).toBe(false);
    expect(existsSync(join(media, '.sala'))).toBe(false);
    expect(readFileSync(join(cfg, 'config.json'), 'utf8')).toBe(before);
    expect(libraryDiskPresent(media, { dir: cfg })).toBe(false);
  });

  it('treats a marker with another libraryId as a different disk', () => {
    const cfg = join(tmp(), 'cfg');
    const media = tmp();
    writeUserConfig({ contentDir: media, libraryId: 'mine' }, cfg);
    writeMarker(media, 'someone-else');
    expect(configStatus(media, { dir: cfg }).status).toBe('missing');
    expect(libraryDiskPresent(media, { dir: cfg })).toBe(false);
    expect(readUserConfig({ dir: cfg })?.libraryId).toBe('mine');
  });

  it('adopts the marker id when config.json has none, and keeps hlsDir and contentDev', () => {
    const cfg = join(tmp(), 'cfg');
    const media = tmp();
    const hlsDir = join(media, '.sala', 'hls');
    writeUserConfig({ contentDir: media, hlsDir }, cfg);
    writeMarker(media, 'lib-1');
    expect(configStatus(media, { dir: cfg })).toMatchObject({ status: 'ready', libraryId: 'lib-1' });
    expect(readUserConfig({ dir: cfg })).toEqual({ contentDir: media, libraryId: 'lib-1', hlsDir });
  });

  it('is absent when the folder stops being the device that was saved', () => {
    const cfg = join(tmp(), 'cfg');
    const media = tmp();
    writeMarker(media, 'lib-1');
    writeUserConfig({ contentDir: media, libraryId: 'lib-1', contentDev: statSync(media).dev + 1 }, cfg);
    expect(libraryDiskPresent(media, { dir: cfg })).toBe(false);
    expect(configStatus(media, { dir: cfg }).status).toBe('missing');
    writeUserConfig({ contentDir: media, libraryId: 'lib-1', contentDev: statSync(media).dev }, cfg);
    expect(libraryDiskPresent(media, { dir: cfg })).toBe(true);
  });

  it('reuses the configured id when the wizard re-selects the same folder without a marker, and records no device for a plain folder', () => {
    const cfg = join(tmp(), 'cfg');
    const media = tmp();
    writeUserConfig({ contentDir: media, libraryId: 'lib-x' }, cfg);
    const result = setContentDir(media, { dir: cfg });
    expect(result.ok && result.status.libraryId).toBe('lib-x');
    expect(readUserConfig({ dir: cfg })?.contentDev).toBeUndefined();
  });

  it('without config.json the legacy folder counts as present when it exists', () => {
    const cfg = join(tmp(), 'cfg');
    expect(libraryDiskPresent(tmp(), { dir: cfg })).toBe(true);
    expect(libraryDiskPresent(join(tmp(), 'gone'), { dir: cfg })).toBe(false);
  });
});

describe('hlsDir in config.json (T47d)', () => {
  it('is read when absolute and ignored otherwise', () => {
    const cfg = join(tmp(), 'cfg');
    writeUserConfig({ contentDir: '/c', libraryId: 'a', hlsDir: '/c/.sala/hls' }, cfg);
    expect(readUserConfig({ dir: cfg })?.hlsDir).toBe('/c/.sala/hls');
    writeFileSync(join(cfg, 'config.json'), JSON.stringify({ contentDir: '/c', hlsDir: 'relative/hls' }));
    expect(readUserConfig({ dir: cfg })).toEqual({ contentDir: '/c' });
  });

  it('wins over the default, but an explicit DATA_DIR keeps the historical layout', () => {
    const root = tmp();
    const cfg = join(root, 'cfg');
    writeUserConfig({ contentDir: '/c', libraryId: 'a', hlsDir: '/c/.sala/hls' }, cfg);
    const opts = { root, home: join(root, 'home'), configDir: cfg };
    const env = { XDG_DATA_HOME: join(root, 'xdg') };
    expect(resolveDataPaths(env, opts).hlsDir).toBe('/c/.sala/hls');
    expect(resolveDataPaths({ ...env, DATA_DIR: join(root, 'd') }, opts).hlsDir).toBe(join(root, 'd', 'hls'));
    expect(resolveDataPaths(env, { ...opts, configDir: join(root, 'nocfg') }).hlsDir).toBe(join(root, 'xdg', 'sala', 'hls'));
  });
});

const COPY: StreamInfo = {
  durationS: 100,
  video: { index: 0, codec: 'h264', profile: 'High', pixFmt: 'yuv420p' },
  audio: [{ index: 1, codec: 'aac', language: 'jpn', title: null, channels: 2 }],
  subtitles: [],
  attachments: [],
};
const X264: StreamInfo = { ...COPY, video: { index: 0, codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le' } };
const roomy = async () => ({ bsize: 1024 * 1024, blocks: 2_000_000, bavail: 1_000_000 });

function writePackage(out: string) {
  writeFileSync(
    join(out, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="a",URI="a0/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="group_aud"\nv/index.m3u8\n',
  );
  for (const p of ['v/index.m3u8', 'a0/index.m3u8']) writeFileSync(join(out, p), '#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s\n');
  writeFileSync(join(out, 'v/seg_00000.m4s'), 'x'.repeat(1000));
}

function env(o: { info?: StreamInfo; hls?: 'inside' | 'outside' | 'default'; probe?: () => Promise<StreamInfo> } = {}) {
  const root = tmp();
  const dataDir = join(root, 'state');
  const contentDir = join(root, 'content');
  mkdirSync(contentDir, { recursive: true });
  const hlsDir = o.hls === 'inside' ? join(contentDir, '.sala', 'hls') : o.hls === 'outside' ? join(root, 'elsewhere', 'hls') : undefined;
  const state = { present: true };
  const { db } = setup();
  const titleId = addTitle(db, 'T', { kind: 'anime' });
  const fake: RunFfmpeg = async (args) => {
    if (args.includes('-var_stream_map')) writePackage(dirname(dirname(args.at(-1)!)));
  };
  const worker = createWorker({
    db, dataDir, hlsDir, contentDir, runFfmpeg: fake, statfs: roomy,
    probeStreams: o.probe ?? (async () => o.info ?? X264),
    diskPresent: () => state.present,
  });
  const app = buildApp({ db, dataDir, hlsDir, worker, disk: { present: () => state.present, hlsOnLibrary: o.hls === 'inside' } });
  const source = (rel = 'a.mkv') => {
    writeFileSync(join(contentDir, rel), 'x');
    const id = addFile(db, titleId, { status: 'pending' });
    db.prepare('UPDATE media_files SET path = ?, duration_s = 100 WHERE id = ?').run(rel, id);
    enqueue(db, id);
    return id;
  };
  const file = (id: number) => get<any>(db, 'SELECT * FROM media_files WHERE id = ?', id);
  return { db, app, dataDir, contentDir, hlsDir, state, worker, source, file };
}

describe('explicit hlsDir (T47d)', () => {
  it('writes packages to hlsDir (never dataDir/hls), records meta.json and serves them', async () => {
    const e = env({ hls: 'outside' });
    const id = e.source();
    await e.worker.drain();
    expect(e.file(id)).toMatchObject({ status: 'ready', hls_dir: `hls/${id}`, pkg_mode: 'x264' });
    expect(existsSync(join(e.dataDir, 'hls'))).toBe(false);
    expect(existsSync(join(e.hlsDir!, String(id), 'master.m3u8'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(e.hlsDir!, String(id), 'meta.json'), 'utf8'));
    expect(meta).toEqual({ path: 'a.mkv', size: 1, planHash: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect((await e.app.inject(`/api/stream/${id}/master.m3u8`)).statusCode).toBe(200);
    expect((await e.app.inject(`/api/stream/${id}/meta.json`)).statusCode).toBe(404);
  });

  it('without hlsDir keeps <dataDir>/hls', async () => {
    const e = env();
    const id = e.source();
    await e.worker.drain();
    expect(existsSync(join(e.dataDir, 'hls', String(id), 'master.m3u8'))).toBe(true);
  });
});

describe('absent disk (T47d)', () => {
  it('claims nothing, creates no .sala and keeps the file queued; resumes by itself when the disk returns', async () => {
    const e = env({ hls: 'inside' });
    const id = e.source();
    e.state.present = false;
    e.worker.kick();
    await e.worker.drain();
    expect(e.file(id).status).toBe('pending');
    expect(existsSync(join(e.contentDir, '.sala'))).toBe(false);
    expect(e.worker.diskAbsent()).toBe(true);
    const activity = (await e.app.inject('/api/activity')).json();
    expect(activity).toMatchObject({ diskAbsent: true, queuedTotal: 1, failed: [] });

    e.state.present = true;
    await e.worker.drain();
    expect(e.file(id).status).toBe('ready');
    expect(e.worker.diskAbsent()).toBe(false);
    expect((await e.app.inject('/api/activity')).json().diskAbsent).toBe(false);
  });

  it('requeues instead of failing when the disk vanishes mid-job', async () => {
    let e!: ReturnType<typeof env>;
    e = env({ probe: async () => { e.state.present = false; throw new Error('I/O error'); } });
    const id = e.source();
    e.worker.kick();
    await new Promise((r) => setTimeout(r, 50));
    expect(e.file(id).status).toBe('pending');
    expect(get<any>(e.db, 'SELECT status FROM jobs WHERE media_file_id = ?', id).status).toBe('queued');
  });

  it('still fails a file whose original is gone while the disk is present', async () => {
    const e = env();
    const id = e.source();
    rmSync(join(e.contentDir, 'a.mkv'));
    await e.worker.drain();
    expect(e.file(id)).toMatchObject({ status: 'error' });
  });

  it('answers /api/stream 503 disk_absent when the package lives on the absent disk', async () => {
    const e = env({ hls: 'inside' });
    const id = e.source();
    await e.worker.drain();
    expect((await e.app.inject(`/api/stream/${id}/master.m3u8`)).statusCode).toBe(200);
    e.state.present = false;
    const res = await e.app.inject(`/api/stream/${id}/master.m3u8`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'disk_absent' });
  });

  it('serves a local package while the library disk is absent, but 503s a package that cannot be built', async () => {
    const e = env({ info: X264 });
    const id = e.source();
    await e.worker.drain();
    e.state.present = false;
    expect((await e.app.inject(`/api/stream/${id}/master.m3u8`)).statusCode).toBe(200);
    expect((await e.app.inject(`/api/stream/99/master.m3u8`)).json()).toEqual({ error: 'disk_absent' });
  });

  it('does not build a lazy copy package or create the HLS tree while absent', async () => {
    const e = env({ info: COPY, hls: 'inside' });
    const id = e.source();
    await e.worker.drain();
    expect(e.file(id)).toMatchObject({ status: 'ready', hls_dir: null, pkg_mode: 'copy' });
    e.state.present = false;
    const play = await e.app.inject({ method: 'POST', url: `/api/media-files/${id}/play` });
    expect(play.statusCode).toBe(503);
    expect(play.json()).toEqual({ error: 'disk_absent' });
    expect(existsSync(join(e.contentDir, '.sala'))).toBe(false);
  });
});
