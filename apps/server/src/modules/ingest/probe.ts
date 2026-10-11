import { type FfprobeStream, ffprobeTrack, runFfprobeJson } from '../processing/ffmpeg.ts';
import { type Chapter, parseChapters } from '../catalog/chapters.ts';

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
  /** T72: container title tag ("S05E06-Orario: Distorted City"); absent when the probe did not look (fakes). */
  titleTag?: string | null;
  /** Absent when the probe did not look (tests, fakes): the file is then backfilled lazily. */
  chapters?: Chapter[];
}

// Rejects when the file cannot be read as media, which is how an unfinished download looks.
export type Probe = (absPath: string) => Promise<ProbeResult>;

export const ffprobe: Probe = async (absPath) => {
  const data = await runFfprobeJson<{ format?: { duration?: string; tags?: Record<string, string> }; streams?: FfprobeStream[] } & Parameters<typeof parseChapters>[0]>(
    absPath,
    ['-show_chapters'],
  );
  const durationS = Number(data.format?.duration);
  const streams = data.streams ?? [];
  if (!Number.isFinite(durationS) || durationS <= 0 || streams.length === 0) throw new Error('ffprobe: no usable media');
  return {
    durationS,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({ ...ffprobeTrack(s), channels: s.channels })),
    subtitles: streams.filter((s) => s.codec_type === 'subtitle').map(ffprobeTrack),
    titleTag: data.format?.tags?.title ?? null,
    chapters: parseChapters(data),
  };
};
