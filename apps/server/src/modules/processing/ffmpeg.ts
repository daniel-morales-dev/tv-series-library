import { execFile, spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { procStart, watchProgress } from './proc.ts';
import type { AttachmentInfo, Plan, StreamInfo } from './plan.ts';

const execFileAsync = promisify(execFile);

export const SEGMENT_SECONDS = 6;

// Windows installs ship ffmpeg under `<install>\ffmpeg\bin` (the launcher also prepends it to PATH).
// The env override makes that location explicit and lets tests point at a fake binary.
export const ffmpegBin = (env: Record<string, string | undefined> = process.env): string => env.FFMPEG_BIN || 'ffmpeg';
export const ffprobeBin = (env: Record<string, string | undefined> = process.env): string => env.FFPROBE_BIN || 'ffprobe';

export interface SpawnInfo {
  pid: number;
  pidStart: number;
}

export interface RunOptions {
  /** Seconds of output written so far (from `-progress`). */
  onProgress?: (outTimeS: number) => void;
  signal?: AbortSignal;
  /**
   * Long run that must outlive this server: own session, output in files, progress read from `progressFile`.
   * Without it the child is tied to this process and dies with it.
   */
  detached?: { progressFile: string; logFile: string };
  onSpawn?: (info: SpawnInfo) => void;
}

/** Abort reason: stop watching but leave the detached ffmpeg running so the next server adopts it. */
export class KeepChildren extends Error {
  constructor() {
    super('server stopping: ffmpeg left running');
  }
}
export const keepsChildren = (signal?: AbortSignal): boolean => signal?.aborted === true && signal.reason instanceof KeepChildren;

// Rejects with the tail of ffmpeg's stderr when it exits non-zero.
export type RunFfmpeg = (args: string[], opts?: RunOptions) => Promise<void>;
export type ProbeStreams = (absPath: string) => Promise<StreamInfo>;

export const PROGRESS_FILE = 'progress.txt';
export const LOG_FILE = 'ffmpeg.log';
const KILL_ESCALATION_MS = 5_000;
const TAIL_BYTES = 4000;

// PROCESS_NICE (default 19): lowest CPU priority (which also drops I/O to the lowest best-effort class)
// so playback and the UI stay responsive. Read per spawn so a restart picks up .env changes.
export function niceFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PROCESS_NICE;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= -20 && n <= 19 ? n : 19;
}

export function createRunFfmpeg({ bin = ffmpegBin(), pollMs = 1_000, killAfterMs = KILL_ESCALATION_MS }: { bin?: string; pollMs?: number; killAfterMs?: number } = {}): RunFfmpeg {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const { signal, detached } = opts;
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      let logFd: number | undefined;
      if (detached) logFd = openSync(detached.logFile, 'a');
      const child = spawn(bin, args, { detached: !!detached, stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'pipe'] });
      if (logFd !== undefined) closeSync(logFd);
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d).slice(-TAIL_BYTES);
      });
      if (detached) child.unref();
      const pid = child.pid;
      if (pid) {
        try {
          setPriority(pid, niceFromEnv());
        } catch {}
        const pidStart = procStart(pid);
        if (pidStart !== null) opts.onSpawn?.({ pid, pidStart });
      }
      const stopWatching = detached ? watchProgress(detached.progressFile, opts.onProgress, pollMs) : () => {};
      let escalate: NodeJS.Timeout | undefined;
      const done = (fn: () => void) => {
        stopWatching();
        clearTimeout(escalate);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      function onAbort() {
        if (keepsChildren(signal)) return done(() => reject(signal!.reason));
        // SIGTERM kills the child on every platform (TerminateProcess on Windows); SIGCONT and SIGKILL
        // do not exist there (ERR_UNKNOWN_SIGNAL) and neither is needed: the kill is immediate.
        child.kill('SIGTERM');
        if (process.platform !== 'win32') {
          child.kill('SIGCONT'); // a paused (SIGSTOP) ffmpeg only handles SIGTERM once continued
          escalate = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
          escalate.unref();
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => done(() => reject(err)));
      child.on('close', (code) => {
        if (signal?.aborted) return done(() => reject(signal.reason ?? new Error('aborted')));
        if (detached) stderr = tail(detached.logFile);
        done(() => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`))));
      });
    });
}

// Only the end of the log: a source that makes ffmpeg log an error per packet can grow it to hundreds of MB, and reading it whole blocks the event loop.
function tail(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const runFfmpeg: RunFfmpeg = createRunFfmpeg();

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
}

export const probeStreams: ProbeStreams = async (absPath) => {
  const { stdout } = await execFileAsync(
    ffprobeBin(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
  );
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: FfprobeStream[] };
  const streams = data.streams ?? [];
  const of = (type: string) => streams.filter((s) => s.codec_type === type);
  const track = (s: FfprobeStream) => ({
    index: s.index,
    codec: s.codec_name ?? null,
    language: s.tags?.language ?? null,
    title: s.tags?.title ?? null,
  });
  // Cover art is reported as a video stream; the real one is the first that is not an attached picture.
  const video = of('video').find((s) => !s.disposition?.attached_pic);
  return {
    durationS: Number(data.format?.duration),
    video: video ? { index: video.index, codec: video.codec_name ?? null, profile: video.profile ?? null, pixFmt: video.pix_fmt ?? null } : null,
    audio: of('audio').map((s) => ({ ...track(s), channels: s.channels })),
    subtitles: of('subtitle').map(track),
    attachments: of('attachment').map(
      (s): AttachmentInfo => ({ index: s.index, filename: s.tags?.filename ?? null, mimetype: s.tags?.mimetype ?? null }),
    ),
  };
};

const BASE = ['-y', '-nostdin', '-v', 'error'];

// One run for the video and every audio rendition: fMP4 segments, one folder per rendition.
// The playlist is `event` so it can be played while it grows; ffmpeg adds ENDLIST when done.
const TUNES = new Set(['film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency']);

// x264 quality knobs (T47f), read once per call so a restart picks up .env changes.
export function encodeProfile(env: Record<string, string | undefined> = process.env): { crf: number; tune: string | null } {
  const crf = Number(env.ENCODE_CRF);
  const tune = env.ENCODE_TUNE ?? 'animation';
  return {
    crf: Number.isInteger(crf) && env.ENCODE_CRF !== '' && crf >= 0 && crf <= 51 ? crf : 23,
    tune: tune === 'none' ? null : TUNES.has(tune) ? tune : 'animation',
  };
}

export function mainArgs(
  plan: Plan,
  src: string,
  outDir: string,
  opts: { threads?: number; crf?: number; tune?: string | null } = {},
): string[] {
  const profile = encodeProfile();
  const crf = opts.crf ?? profile.crf;
  const tune = opts.tune === undefined ? profile.tune : opts.tune;
  const cap = plan.video.maxrate ? ['-maxrate', plan.video.maxrate, '-bufsize', plan.video.bufsize!] : [];
  const video =
    plan.video.mode === 'copy'
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), ...(tune ? ['-tune', tune] : []), ...cap, '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...(opts.threads ? ['-threads', String(opts.threads)] : [])];
  const audio = plan.audio.flatMap((a, i) =>
    a.mode === 'copy' ? [`-c:a:${i}`, 'copy'] : [`-c:a:${i}`, 'aac', `-b:a:${i}`, a.bitrate!, `-ac:a:${i}`, String(a.channels)],
  );
  const streamMap = [
    'v:0,agroup:aud,name:v',
    ...plan.audio.map((a, i) => `a:${i},agroup:aud,name:a${a.n}${a.language ? `,language:${a.language}` : ''}${i === 0 ? ',default:yes' : ''}`),
  ].join(' ');
  return [
    ...BASE,
    '-progress', join(outDir, PROGRESS_FILE), '-nostats',
    '-i', src,
    '-map', `0:${plan.video.index}`,
    ...plan.audio.flatMap((a) => ['-map', `0:${a.index}`]),
    ...video,
    ...audio,
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(outDir, '%v/seg_%05d.m4s'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', streamMap,
    join(outDir, '%v/index.m3u8'),
  ];
}

// Subtitles (vtt, and the untouched ass) and attached fonts in a single quick run.
export function extractArgs(plan: Plan, src: string, outDir: string): string[] {
  const subs = plan.subtitles.flatMap((s) => [
    ...(s.vtt ? ['-map', `0:${s.index}`, '-c:s', 'webvtt', join(outDir, s.vtt)] : []),
    ...(s.ass ? ['-map', `0:${s.index}`, '-c:s', s.codec === 'ass' ? 'copy' : 'ass', join(outDir, s.ass)] : []),
  ]);
  return [
    ...BASE,
    ...plan.fonts.flatMap((f) => [`-dump_attachment:${f.index}`, join(outDir, f.file)]),
    '-i', src,
    // Dumping attachments needs an output, so fonts alone get a throwaway one-frame output.
    ...(subs.length > 0 ? subs : ['-map', `0:${plan.video.index}`, '-frames:v', '1', '-f', 'null', '-']),
  ];
}

// ffmpeg names the renditions `audio_<n>` in playlist order; players show the track title or language instead.
export function nameRenditions(master: string, plan: Plan): string {
  let next = 0;
  return master.replace(/NAME="audio_\d+"/g, () => {
    const a = plan.audio[next];
    const name = (a?.title ?? a?.language ?? `Audio ${next + 1}`).replaceAll('"', "'");
    next++;
    return `NAME="${name}"`;
  });
}
