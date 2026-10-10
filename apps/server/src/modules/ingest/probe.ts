import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type Chapter, parseChapters } from '../catalog/chapters.ts';

const execFileAsync = promisify(execFile);

export interface TrackInfo {
  /** Stream index inside the file (usable as `-map 0:<index>`). */
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  channels?: number;
}

export interface ProbeResult {
  durationS: number;
  audio: TrackInfo[];
  subtitles: TrackInfo[];
  /** Absent when the probe did not look (tests, fakes): the file is then backfilled lazily. */
  chapters?: Chapter[];
}

// Rejects when the file cannot be read as media, which is how an unfinished download looks.
export type Probe = (absPath: string) => Promise<ProbeResult>;

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  tags?: Record<string, string>;
}

export const ffprobe: Probe = async (absPath) => {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', absPath],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
  );
  const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: FfprobeStream[] } & Parameters<typeof parseChapters>[0];
  const durationS = Number(data.format?.duration);
  const streams = data.streams ?? [];
  if (!Number.isFinite(durationS) || durationS <= 0 || streams.length === 0) throw new Error('ffprobe: no usable media');
  const track = (s: FfprobeStream): TrackInfo => ({
    index: s.index,
    codec: s.codec_name ?? null,
    language: s.tags?.language ?? null,
    title: s.tags?.title ?? null,
  });
  return {
    durationS,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({ ...track(s), channels: s.channels })),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle').map(track),
    chapters: parseChapters(data),
  };
};
