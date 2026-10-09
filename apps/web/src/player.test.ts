import { describe, expect, it } from 'vitest';
import { defaultSubtitle, nextFile, resumePosition, subtitleLabel } from './player.ts';
import type { MediaFile, SubtitleTrack, TitleDetail } from './types.ts';

const p = (mediaFileId: number, positionS: number, completed = false) => ({ mediaFileId, positionS, durationS: 1400, completed });

describe('resumePosition', () => {
  it('returns the saved position', () => expect(resumePosition([p(1, 300)], 1)).toBe(300));
  it('starts at 0 when nothing is saved', () => {
    expect(resumePosition(undefined, 1)).toBe(0);
    expect(resumePosition([p(2, 300)], 1)).toBe(0);
  });
  it('starts at 0 when completed or under 10 s', () => {
    expect(resumePosition([p(1, 300, true)], 1)).toBe(0);
    expect(resumePosition([p(1, 9.9)], 1)).toBe(0);
    expect(resumePosition([p(1, 10)], 1)).toBe(10);
  });
});

const sub = (index: number, language: string | null, supported = true): SubtitleTrack => ({
  index, language, title: null, supported, vtt: supported ? `subs/${index}.vtt` : null,
});

describe('defaultSubtitle', () => {
  it('picks the first Spanish track (es / spa)', () => {
    expect(defaultSubtitle([sub(0, 'eng'), sub(1, 'spa'), sub(2, 'es')])).toBe(1);
    expect(defaultSubtitle([sub(0, 'es-419')])).toBe(0);
  });
  it('ignores unsupported tracks', () => expect(defaultSubtitle([sub(0, 'spa', false), sub(1, 'eng')])).toBe(-1));
  it('returns -1 when none', () => expect(defaultSubtitle([])).toBe(-1));
});

describe('subtitleLabel', () => {
  it('prefers title, then language, then number', () => {
    expect(subtitleLabel({ ...sub(0, 'eng'), title: 'Forced' }, 0)).toBe('Forced');
    expect(subtitleLabel(sub(0, 'eng'), 0)).toBe('eng');
    expect(subtitleLabel(sub(0, null), 2)).toBe('Subtítulo 3');
  });
});

const file = (id: number, episodeId: number | null, extraLabel: string | null = null): MediaFile => ({
  id, status: 'ready', episodeId, extraLabel, durationS: 1400, audioTracks: [], subtitleTracks: [],
});
const detail = {
  seasons: [
    { id: 1, number: 2, name: null, episodes: [{ id: 21, number: 1, name: 'Dos-uno' }] },
    { id: 0, number: 1, name: null, episodes: [{ id: 12, number: 2, name: 'Uno-dos' }, { id: 11, number: 1, name: 'Uno-uno' }, { id: 13, number: 3, name: 'Sin archivo' }] },
  ],
  files: [file(100, 21), file(101, 11), file(102, 12), file(103, null, 'Extra')],
} as unknown as TitleDetail;

describe('nextFile', () => {
  it('follows season then episode order', () => {
    expect(nextFile(detail, 101)).toEqual({ fileId: 102, name: 'Uno-dos' });
  });
  it('skips episodes without a file and crosses seasons', () => {
    expect(nextFile(detail, 102)).toEqual({ fileId: 100, name: 'Dos-uno' });
  });
  it('returns null at the end, for extras and unknown files', () => {
    expect(nextFile(detail, 100)).toBeNull();
    expect(nextFile(detail, 103)).toBeNull();
    expect(nextFile(detail, 999)).toBeNull();
  });
});
