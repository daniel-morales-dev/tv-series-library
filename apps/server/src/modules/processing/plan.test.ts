import { describe, expect, it } from 'vitest';
import { type StreamInfo, buildPlan } from './plan.ts';

const h264 = (over: Partial<NonNullable<StreamInfo['video']>> = {}) => ({
  index: 0,
  codec: 'h264',
  profile: 'High',
  pixFmt: 'yuv420p',
  ...over,
});
const info = (over: Partial<StreamInfo> = {}): StreamInfo => ({
  durationS: 100,
  video: h264(),
  audio: [],
  subtitles: [],
  attachments: [],
  ...over,
});
const audio = (codec: string, channels?: number, index = 1) => ({ index, codec, language: 'jpn', title: null, channels });
const sub = (codec: string | null, index = 2) => ({ index, codec, language: 'eng', title: null });

describe('buildPlan video', () => {
  it.each([
    ['High', 'yuv420p'],
    ['Main', 'yuv420p'],
    ['Constrained Baseline', 'yuv420p'],
    ['Baseline', 'yuv420p'],
    ['High', 'yuvj420p'],
  ])('copies 8-bit H.264 %s %s', (profile, pixFmt) => {
    expect(buildPlan(info({ video: h264({ profile, pixFmt }) })).video).toEqual({ index: 0, mode: 'copy' });
  });

  it.each([
    ['High 10 (10-bit)', h264({ profile: 'High 10', pixFmt: 'yuv420p10le' })],
    ['High 4:4:4', h264({ profile: 'High 4:4:4 Predictive', pixFmt: 'yuv444p' })],
    ['Extended', h264({ profile: 'Extended' })],
    ['HEVC', h264({ codec: 'hevc', profile: 'Main' })],
    ['unknown profile', h264({ profile: null })],
  ])('re-encodes %s with x264', (_name, video) => {
    expect(buildPlan(info({ video })).video).toEqual({ index: 0, mode: 'x264' });
  });

  it('rejects files without video', () => {
    expect(() => buildPlan(info({ video: null }))).toThrow(/no video/);
  });
});

describe('buildPlan audio', () => {
  it('copies AAC and MP3', () => {
    const p = buildPlan(info({ audio: [audio('aac', 2), audio('mp3', 2, 2)] }));
    expect(p.audio.map((a) => a.mode)).toEqual(['copy', 'copy']);
  });

  it.each([
    ['flac', 2, 2, '192k'],
    ['flac', 1, 1, '192k'],
    ['ac3', 6, 6, '384k'],
    ['dts', 8, 6, '384k'],
    ['opus', undefined, 2, '192k'],
  ])('transcodes %s (%s ch) to AAC with %s channels at %s', (codec, channels, outCh, bitrate) => {
    const [a] = buildPlan(info({ audio: [audio(codec, channels)] })).audio;
    expect(a).toMatchObject({ mode: 'aac', channels: outCh, bitrate });
  });

  it('numbers renditions by position and points each one at its playlist', () => {
    const p = buildPlan(info({ audio: [audio('flac', 2, 1), audio('aac', 2, 4)] }));
    expect(p.audio.map((a) => [a.n, a.index, a.playlist])).toEqual([
      [0, 1, 'a0/index.m3u8'],
      [1, 4, 'a1/index.m3u8'],
    ]);
  });
});

describe('buildPlan subtitles and fonts', () => {
  it('turns ASS into vtt plus the untouched ass', () => {
    const [s] = buildPlan(info({ subtitles: [sub('ass')] })).subtitles;
    expect(s).toMatchObject({ n: 0, supported: true, vtt: 'subs/0.vtt', ass: 'subs/0.ass' });
  });

  it.each(['subrip', 'mov_text', 'webvtt'])('turns %s into vtt only', (codec) => {
    const [s] = buildPlan(info({ subtitles: [sub(codec)] })).subtitles;
    expect(s).toMatchObject({ supported: true, vtt: 'subs/0.vtt', ass: null });
  });

  it.each(['hdmv_pgs_subtitle', 'dvd_subtitle', null])('skips image or unknown subtitles (%s)', (codec) => {
    const [s] = buildPlan(info({ subtitles: [sub(codec)] })).subtitles;
    expect(s).toMatchObject({ supported: false, vtt: null, ass: null });
  });

  it('keeps subtitle numbers stable when one is skipped', () => {
    const p = buildPlan(info({ subtitles: [sub('hdmv_pgs_subtitle', 2), sub('subrip', 3)] }));
    expect(p.subtitles.map((s) => [s.n, s.vtt])).toEqual([[0, null], [1, 'subs/1.vtt']]);
  });

  it('extracts font attachments with safe, unique names and ignores other attachments', () => {
    const p = buildPlan(
      info({
        attachments: [
          { index: 5, filename: 'Arial.ttf', mimetype: 'application/x-truetype-font' },
          { index: 6, filename: '../../etc/Arial.ttf', mimetype: null },
          { index: 7, filename: 'cover.jpg', mimetype: 'image/jpeg' },
          { index: 8, filename: null, mimetype: 'font/otf' },
        ],
      }),
    );
    expect(p.fonts).toEqual([
      { index: 5, file: 'fonts/Arial.ttf' },
      { index: 6, file: 'fonts/6_Arial.ttf' },
      { index: 8, file: 'fonts/font8.otf' },
    ]);
  });
});
