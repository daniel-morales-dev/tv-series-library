import { execFile, spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AttachmentInfo, Plan, StreamInfo } from './plan.ts';

const execFileAsync = promisify(execFile);

export const SEGMENT_SECONDS = 6;

export interface RunOptions {
  /** Seconds of output written so far (from `-progress`). */
  onProgress?: (outTimeS: number) => void;
  signal?: AbortSignal;
}

// Rejects with the tail of ffmpeg's stderr when it exits non-zero.
export type RunFfmpeg = (args: string[], opts?: RunOptions) => Promise<void>;
export type ProbeStreams = (absPath: string) => Promise<StreamInfo>;

export const runFfmpeg: RunFfmpeg = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    // Lowest CPU priority (which also drops I/O to the lowest best-effort class) so playback and the UI stay responsive.
    try {
      if (child.pid) setPriority(child.pid, 19);
    } catch {}
    let stderr = '';
    let buffered = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.stdout.on('data', (d: Buffer) => {
      buffered += d;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)$/.exec(line);
        if (m) opts.onProgress?.(Number(m[1]) / 1e6);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`))));
  });

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
    'ffprobe',
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
export function mainArgs(plan: Plan, src: string, outDir: string, opts: { threads?: number } = {}): string[] {
  const video =
    plan.video.mode === 'copy'
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*2)', ...(opts.threads ? ['-threads', String(opts.threads)] : [])];
  const audio = plan.audio.flatMap((a, i) =>
    a.mode === 'copy' ? [`-c:a:${i}`, 'copy'] : [`-c:a:${i}`, 'aac', `-b:a:${i}`, a.bitrate!, `-ac:a:${i}`, String(a.channels)],
  );
  const streamMap = [
    'v:0,agroup:aud,name:v',
    ...plan.audio.map((a, i) => `a:${i},agroup:aud,name:a${a.n}${a.language ? `,language:${a.language}` : ''}${i === 0 ? ',default:yes' : ''}`),
  ].join(' ');
  return [
    ...BASE,
    '-progress', 'pipe:1', '-nostats',
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
