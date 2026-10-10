import { basename } from 'node:path';
import type { TrackInfo } from '../ingest/probe.ts';

export interface VideoInfo {
  index: number;
  codec: string | null;
  profile: string | null;
  pixFmt: string | null;
}

export interface AttachmentInfo {
  index: number;
  filename: string | null;
  mimetype: string | null;
}

export interface StreamInfo {
  durationS: number;
  video: VideoInfo | null;
  audio: TrackInfo[];
  subtitles: TrackInfo[];
  attachments: AttachmentInfo[];
}

export interface AudioPlan extends TrackInfo {
  /** Position among the audio tracks; names the output folder `a<n>`. */
  n: number;
  mode: 'copy' | 'aac';
  /** Channels the player gets: capped at 6 when transcoding, as-is for copies. */
  channels: number;
  bitrate: string | null;
  playlist: string;
}

export interface SubtitlePlan extends TrackInfo {
  n: number;
  supported: boolean;
  vtt: string | null;
  ass: string | null;
}

export interface Plan {
  video: { index: number; mode: 'copy' | 'x264'; maxrate?: string; bufsize?: string };
  audio: AudioPlan[];
  subtitles: SubtitlePlan[];
  fonts: { index: number; file: string }[];
}

const MAX_CHANNELS = 6;
const COPY_AUDIO = new Set(['aac', 'mp3']);
const TEXT_SUBS = new Set(['ass', 'ssa', 'subrip', 'mov_text', 'webvtt']);
const ASS_SUBS = new Set(['ass', 'ssa']);
const COPY_PROFILES = /^(Constrained )?Baseline$|^Main$|^High$/;
const FONT_FILE = /\.(ttf|otf|ttc|woff2?)$/i;

function videoMode(v: NonNullable<StreamInfo['video']>): 'copy' | 'x264' {
  const eightBit = v.pixFmt === 'yuv420p' || v.pixFmt === 'yuvj420p';
  return v.codec === 'h264' && eightBit && v.profile !== null && COPY_PROFILES.test(v.profile) ? 'copy' : 'x264';
}

function planFonts(attachments: AttachmentInfo[]): Plan['fonts'] {
  const used = new Set<string>();
  const fonts: Plan['fonts'] = [];
  for (const a of attachments) {
    const isFont = (a.filename && FONT_FILE.test(a.filename)) || /font|opentype/i.test(a.mimetype ?? '');
    if (!isFont) continue;
    let name = a.filename ? basename(a.filename.replaceAll('\\', '/')).replace(/[^\w.-]/g, '_') : '';
    if (!name) name = `font${a.index}${/otf|opentype/i.test(a.mimetype ?? '') ? '.otf' : '.ttf'}`;
    if (used.has(name)) name = `${a.index}_${name}`;
    used.add(name);
    fonts.push({ index: a.index, file: `fonts/${name}` });
  }
  return fonts;
}

// Bitrate cap for x264 re-encodes: tight for HEVC / 10-bit sources (heavy, and 10->8 bit
// inflates banding noise at high rates), looser for the rest.
function bitrateCap(v: NonNullable<StreamInfo['video']>): { maxrate: string; bufsize: string } {
  const heavy = v.codec === 'hevc' || (v.pixFmt ?? '').includes('10');
  return heavy ? { maxrate: '4M', bufsize: '8M' } : { maxrate: '8M', bufsize: '16M' };
}

export function buildPlan(info: StreamInfo): Plan {
  if (!info.video) throw new Error('no video stream');
  return {
    video: (() => {
      const mode = videoMode(info.video!);
      return mode === 'copy' ? { index: info.video!.index, mode } : { index: info.video!.index, mode, ...bitrateCap(info.video!) };
    })(),
    audio: info.audio.map((a, n) => {
      const copy = a.codec !== null && COPY_AUDIO.has(a.codec);
      const channels = copy ? (a.channels ?? 2) : Math.min(a.channels ?? 2, MAX_CHANNELS);
      return {
        ...a,
        n,
        mode: copy ? 'copy' : 'aac',
        channels,
        bitrate: copy ? null : channels > 2 ? '384k' : '192k',
        playlist: `a${n}/index.m3u8`,
      };
    }),
    subtitles: info.subtitles.map((s, n) => {
      const supported = s.codec !== null && TEXT_SUBS.has(s.codec);
      return {
        ...s,
        n,
        supported,
        vtt: supported ? `subs/${n}.vtt` : null,
        ass: s.codec !== null && ASS_SUBS.has(s.codec) ? `subs/${n}.ass` : null,
      };
    }),
    fonts: planFonts(info.attachments),
  };
}
