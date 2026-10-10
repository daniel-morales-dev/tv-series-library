import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LOG_FILE, PROGRESS_FILE, type ProbeStreams, type RunFfmpeg, type SpawnInfo, extractArgs, keepsChildren, mainArgs, nameRenditions } from './ffmpeg.ts';
import { isOurFfmpeg, readProgress, terminate, waitForExit, watchProgress } from './proc.ts';
import { ESTIMATE_RATIO, dirBytes } from './cache.ts';
import { dedupeFontsDir } from './fonts.ts';
import { type Plan, buildPlan } from './plan.ts';
import type { ProcessResult, ProcessTracks } from './queue.ts';

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
  /** HLS root; defaults to `<dataDir>/hls`. */
  hlsDir?: string;
  /** Throws DiskAbsentError when the library disk is gone; checked before the package folder is created. */
  assertDisk?: () => void;
  contentDir: string;
  runFfmpeg: RunFfmpeg;
  probeStreams: ProbeStreams;
  threads?: number;
  /** How often progress files and adopted processes are polled. */
  pollMs?: number;
  /** Called before any package is written: throws (LowDiskError) when the volume cannot take `neededBytes` safely. */
  ensureSpace?: (neededBytes: number, mediaFileId: number) => Promise<void>;
}

/** A job's ffmpeg left running by the previous server. */
export interface Adoption extends SpawnInfo {
  planHash: string | null;
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

// An encode that says `progress=end` but stopped well short of the source duration is truncated (ffmpeg adds a few seconds of slack).
const endedShort = (outTimeS: number | null, durationS: number) => durationS > 0 && (outTimeS ?? 0) < durationS - Math.max(5, durationS * 0.01);

// Waits for an ffmpeg started by a previous server. true = it finished the package; false = start over.
async function adoptRunning(
  deps: ProcessDeps,
  adopt: Adoption,
  ctx: { tmpDir: string; planHash: string; signal?: AbortSignal; onProgress: (outTimeS: number) => void },
): Promise<boolean> {
  const { tmpDir, signal } = ctx;
  if (!isOurFfmpeg(adopt.pid, adopt.pidStart, tmpDir)) return false;
  const progressFile = join(tmpDir, PROGRESS_FILE);
  // Anything unverifiable: the process is verifiably ours, so stop it (one writer per folder) and start over.
  if (adopt.planHash !== ctx.planHash || readProgress(progressFile) === null) {
    await terminate(adopt.pid, adopt.pidStart);
    return false;
  }
  const stopWatching = watchProgress(progressFile, ctx.onProgress, deps.pollMs);
  try {
    await waitForExit(adopt.pid, adopt.pidStart, { signal, pollMs: deps.pollMs });
  } catch (err) {
    if (!keepsChildren(signal)) await terminate(adopt.pid, adopt.pidStart);
    throw err;
  } finally {
    stopWatching();
  }
  return readProgress(progressFile)?.ended === true;
}

// Writes the HLS package to `hls/<id>.tmp` and swaps it into place only when everything succeeded.
export async function processMedia(
  deps: ProcessDeps,
  file: { id: number; path: string },
  opts: {
    onProgress?: (fraction: number) => void;
    onTracks?: (tracks: ProcessTracks) => void;
    /** A copy-mode source is left unpackaged (T47c); the package is built when somebody plays it. */
    lazyCopy?: boolean;
    onSpawn?: (info: SpawnInfo & { planHash: string }) => void;
    adopt?: Adoption;
    signal?: AbortSignal;
  } = {},
): Promise<ProcessResult> {
  const src = join(deps.contentDir, file.path);
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat?.isFile()) throw new SourceMissingError(file.path);

  const info = await deps.probeStreams(src);
  const plan = buildPlan(info);
  const rel = `hls/${file.id}`;
  const finalDir = join(resolve(deps.hlsDir ?? join(deps.dataDir, 'hls')), String(file.id));
  const tmpDir = `${finalDir}.tmp`;
  const tracks = {
    audio: plan.audio.map((a) => ({ index: a.index, codec: a.codec, language: a.language, title: a.title, channels: a.channels, playlist: a.playlist })),
    subtitles: plan.subtitles.map((s) => ({
      index: s.index, codec: s.codec, language: s.language, title: s.title, supported: s.supported, vtt: s.vtt, ass: s.ass,
    })),
  };
  const mode = plan.video.mode;
  if (opts.lazyCopy && !opts.adopt && mode === 'copy') {
    opts.onTracks?.(tracks);
    return { hlsDir: null, mode, ...tracks };
  }
  const args = mainArgs(plan, src, tmpDir, { threads: deps.threads });
  const planHash = createHash('sha1').update(JSON.stringify(args)).digest('hex');
  const { signal } = opts;
  const report = (s: number) => opts.onProgress?.(info.durationS > 0 ? Math.min(s / info.durationS, 1) : 0);

  try {
    let finished = false;
    if (opts.adopt) {
      opts.onTracks?.(tracks);
      finished = await adoptRunning(deps, opts.adopt, { tmpDir, planHash, signal, onProgress: report });
    }
    if (!finished) {
      await deps.ensureSpace?.(Math.ceil(srcStat.size * ESTIMATE_RATIO[mode]), file.id);
      deps.assertDisk?.();
      await rm(tmpDir, { recursive: true, force: true });
      for (const dir of ['v', ...plan.audio.map((a) => `a${a.n}`), 'subs', 'fonts']) await mkdir(join(tmpDir, dir), { recursive: true });
      // Subtitles and fonts first, so they exist as soon as playback can start.
      if (plan.subtitles.some((s) => s.supported) || plan.fonts.length > 0) await deps.runFfmpeg(extractArgs(plan, src, tmpDir), { signal });
      // Best effort: a store that cannot be written just leaves the fonts as plain files.
      if (plan.fonts.length > 0) await dedupeFontsDir(join(tmpDir, 'fonts'), join(resolve(deps.dataDir), 'fonts', '_store')).catch(() => {});

      opts.onTracks?.(tracks);

      // ffmpeg writes the master once, early: name the audio tracks right away so playback shows them.
      let named = false;
      let naming: Promise<void> | undefined;
      await deps.runFfmpeg(args, {
        signal,
        detached: { progressFile: join(tmpDir, PROGRESS_FILE), logFile: join(tmpDir, LOG_FILE) },
        onSpawn: (p) => opts.onSpawn?.({ ...p, planHash }),
        onProgress: (s) => {
          report(s);
          if (named || naming) return;
          naming = nameMaster(tmpDir, plan)
            .then((ok) => void (named = ok), () => {})
            .finally(() => (naming = undefined));
        },
      });
      await naming;
    }
    // Adopted or not, a run that ended short is a truncated package: it takes the worker's single reprocess.
    const end = readProgress(join(tmpDir, PROGRESS_FILE));
    if (end?.ended && endedShort(end.outTimeS, info.durationS)) {
      throw new InvalidPackageError(`invalid HLS package: ffmpeg ended at ${end.outTimeS ?? 0}s of ${info.durationS}s`);
    }
    await Promise.all([PROGRESS_FILE, LOG_FILE].map((f) => rm(join(tmpDir, f), { force: true })));
    await buildMaster(tmpDir, plan, info.durationS);
    await validatePackage(tmpDir);
    // T47d: lets another machine re-adopt the package by matching the original (relative path + size).
    await writeFile(join(tmpDir, 'meta.json'), `${JSON.stringify({ path: file.path, size: srcStat.size, planHash })}\n`);
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
  } catch (err) {
    // The next server adopts the ffmpeg that is still writing here, so its folder must stay.
    if (!keepsChildren(signal)) await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }

  return { hlsDir: rel, mode, bytes: await dirBytes(finalDir), ...tracks };
}
