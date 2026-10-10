import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ProbeStreams, type RunFfmpeg, extractArgs, mainArgs, nameRenditions } from './ffmpeg.ts';
import { type Plan, buildPlan } from './plan.ts';
import type { ProcessResult } from './queue.ts';

const HAS_VARIANT = /^#EXT-X-STREAM-INF:/m;
const ENDS_WITH_PLAYLIST = /\.m3u8\n*$/;
const isCompleteMaster = (text: string) => HAS_VARIANT.test(text) && ENDS_WITH_PLAYLIST.test(text);

// Writes through a sibling file so a player never reads a half-written master.
// Runs mid-encode: skips a master that is not complete yet, and names the tracks once it is.
async function nameMaster(dir: string, plan: Plan): Promise<boolean> {
  const path = join(dir, 'master.m3u8');
  const text = await readFile(path, 'utf8');
  if (!isCompleteMaster(text)) return false;
  await writeFile(`${path}.new`, nameRenditions(text, plan));
  await rename(`${path}.new`, path);
  return true;
}

export interface ProcessDeps {
  dataDir: string;
  contentDir: string;
  runFfmpeg: RunFfmpeg;
  probeStreams: ProbeStreams;
  threads?: number;
}

export class SourceMissingError extends Error {
  constructor(path: string) {
    super(`source file not found: ${path}`);
  }
}

export class InvalidPackageError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// The package replaces the published one only when the master points at files that exist and the video playlist has segments.
export async function validatePackage(dir: string): Promise<void> {
  const masterPath = join(dir, 'master.m3u8');
  const master = await readFile(masterPath, 'utf8').catch(() => null);
  if (master === null) throw new InvalidPackageError(`invalid HLS package: master playlist missing (${masterPath})`);
  if (!isCompleteMaster(master)) throw new InvalidPackageError(`invalid HLS package: incomplete master playlist (${masterPath})`);

  const refs = [...master.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]);
  const lines = master.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const target = lines[i + 1]?.trim();
    if (!target) throw new InvalidPackageError(`invalid HLS package: variant without a playlist URL (${masterPath})`);
    refs.push(target);
  }
  for (const ref of refs) {
    if (!(await stat(join(dir, ref)).catch(() => null))?.isFile()) {
      throw new InvalidPackageError(`invalid HLS package: missing file referenced by the master (${ref})`);
    }
  }

  const videoPath = join(dir, 'v/index.m3u8');
  const video = await readFile(videoPath, 'utf8').catch(() => null);
  if (video === null || !/^#EXTINF:/m.test(video)) {
    throw new InvalidPackageError(`invalid HLS package: video playlist has no segments (${videoPath})`);
  }
}

// Total `seg_*.m4s` bytes of one rendition folder; a missing folder counts as zero.
async function segmentBytes(dir: string, rendition: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(join(dir, rendition)).catch(() => [])) {
    if (!entry.endsWith('.m4s')) continue;
    total += (await stat(join(dir, rendition, entry)).catch(() => null))?.size ?? 0;
  }
  return total;
}

// ffmpeg 6.1.1 can write a master with only the #EXT-X-MEDIA audio lines (sources without per-stream
// bit_rate metadata), so the published master is always rebuilt here from the plan and the segments.
export async function buildMaster(dir: string, plan: Plan, durationS: number): Promise<void> {
  let bytes = await segmentBytes(dir, 'v');
  for (const a of plan.audio) bytes += await segmentBytes(dir, `a${a.n}`);
  const bandwidth = Math.max(1, Math.ceil((bytes * 8) / Math.max(durationS, 1)));

  const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
  for (const [i, a] of plan.audio.entries()) {
    const name = (a.title ?? a.language ?? `Audio ${i + 1}`).replaceAll('"', "'");
    const language = a.language ? `,LANGUAGE="${a.language}"` : '';
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="${name}"${i === 0 ? ',DEFAULT=YES' : ''}${language},URI="${a.playlist}"`);
  }
  // ponytail: bandwidth-only STREAM-INF; add CODECS/RESOLUTION when a player needs them
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AUDIO="group_aud"`, 'v/index.m3u8');

  const path = join(dir, 'master.m3u8');
  await writeFile(`${path}.new`, `${lines.join('\n')}\n`);
  await rename(`${path}.new`, path);
}

// Writes the HLS package to `hls/<id>.tmp` and swaps it into place only when everything succeeded.
export async function processMedia(
  deps: ProcessDeps,
  file: { id: number; path: string },
  opts: { onProgress?: (fraction: number) => void; onTracks?: (tracks: Omit<ProcessResult, 'hlsDir'>) => void; signal?: AbortSignal } = {},
): Promise<ProcessResult> {
  const src = join(deps.contentDir, file.path);
  if (!(await stat(src).catch(() => null))?.isFile()) throw new SourceMissingError(file.path);

  const info = await deps.probeStreams(src);
  const plan = buildPlan(info);
  const rel = `hls/${file.id}`;
  const finalDir = join(deps.dataDir, rel);
  const tmpDir = `${finalDir}.tmp`;
  const tracks = {
    audio: plan.audio.map((a) => ({ index: a.index, codec: a.codec, language: a.language, title: a.title, channels: a.channels, playlist: a.playlist })),
    subtitles: plan.subtitles.map((s) => ({
      index: s.index, codec: s.codec, language: s.language, title: s.title, supported: s.supported, vtt: s.vtt, ass: s.ass,
    })),
  };

  await rm(tmpDir, { recursive: true, force: true });
  try {
    for (const dir of ['v', ...plan.audio.map((a) => `a${a.n}`), 'subs', 'fonts']) await mkdir(join(tmpDir, dir), { recursive: true });
    const { signal } = opts;
    // Subtitles and fonts first, so they exist as soon as playback can start.
    if (plan.subtitles.some((s) => s.supported) || plan.fonts.length > 0) await deps.runFfmpeg(extractArgs(plan, src, tmpDir), { signal });

    opts.onTracks?.(tracks);

    // ffmpeg writes the master once, early: name the audio tracks right away so playback shows them.
    let named = false;
    let naming: Promise<void> | undefined;
    await deps.runFfmpeg(mainArgs(plan, src, tmpDir, { threads: deps.threads }), {
      signal,
      onProgress: (s) => {
        opts.onProgress?.(info.durationS > 0 ? Math.min(s / info.durationS, 1) : 0);
        if (named || naming) return;
        naming = nameMaster(tmpDir, plan)
          .then((ok) => void (named = ok), () => {})
          .finally(() => (naming = undefined));
      },
    });
    await naming;
    await buildMaster(tmpDir, plan, info.durationS);
    await validatePackage(tmpDir);
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return { hlsDir: rel, ...tracks };
}
