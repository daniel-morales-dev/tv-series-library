import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ProbeStreams, type RunFfmpeg, extractArgs, mainArgs, nameRenditions } from './ffmpeg.ts';
import { type Plan, buildPlan } from './plan.ts';
import type { ProcessResult } from './queue.ts';

const HAS_VARIANT = /^#EXT-X-STREAM-INF:/m;
const ENDS_WITH_PLAYLIST = /\.m3u8\n*$/;
const isCompleteMaster = (text: string) => HAS_VARIANT.test(text) && ENDS_WITH_PLAYLIST.test(text);

// Writes through a sibling file so a player never reads a half-written master.
// `strict` runs mid-encode and skips a master that is not complete yet.
async function nameMaster(dir: string, plan: Plan, strict: boolean): Promise<boolean> {
  const path = join(dir, 'master.m3u8');
  const text = await readFile(path, 'utf8');
  if (strict && !isCompleteMaster(text)) return false;
  if (!strict && !HAS_VARIANT.test(text)) {
    throw new InvalidPackageError(`invalid HLS package: master playlist has no #EXT-X-STREAM-INF (${path})`);
  }
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
        naming = nameMaster(tmpDir, plan, true)
          .then((ok) => void (named = ok), () => {})
          .finally(() => (naming = undefined));
      },
    });
    await naming;
    await nameMaster(tmpDir, plan, false);
    await validatePackage(tmpDir);
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return { hlsDir: rel, ...tracks };
}
