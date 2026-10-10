import { describe, expect, it } from 'vitest';
import { defaultSubtitle, nextFile, resumePosition, subtitleLabel } from './player.ts';
import type { Episode, MediaFile, SubtitleTrack, TitleDetail } from './types.ts';

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
  it('shows the language name in Spanish, with the title when it adds information', () => {
    expect(subtitleLabel({ ...sub(0, 'eng'), title: 'Forced' }, 0)).toBe('Inglés · Forced');
    expect(subtitleLabel({ ...sub(0, 'eng'), title: 'English' }, 0)).toBe('Inglés');
    expect(subtitleLabel(sub(0, 'eng'), 0)).toBe('Inglés');
  });
  it('falls back to the title, then a number', () => {
    expect(subtitleLabel({ ...sub(0, null), title: 'Comentarios' }, 0)).toBe('Comentarios');
    expect(subtitleLabel(sub(0, null), 2)).toBe('Subtítulo 3');
  });
});

const episode = (id: number, number: number, name: string | null = null): Episode => ({
  id, number, name, overview: null, runtimeMin: null, stillPath: null, airDate: null,
});
const mediaFile = (id: number, episodeId: number | null, over: Partial<MediaFile> = {}): MediaFile => ({
  id, status: 'ready', episodeId, extraLabel: null, durationS: 1400, audioTracks: [], subtitleTracks: [], ...over,
});
const detail = (files: MediaFile[], episodes = [episode(1, 1, 'E1'), episode(2, 2, 'E2'), episode(3, 3, 'E3')]): TitleDetail => ({
  id: 1, kind: 'series', title: 'S', originalTitle: null, overview: null, year: null, runtimeMin: null,
  rating: null, genres: [], posterPath: null, backdropPath: null, logoPath: null, comingSoon: false,
  seasons: [{ id: 1, number: 1, name: null, episodes }], files, credits: [], progress: [],
});

describe('nextFile', () => {
  it('advances from the newest file of a duplicated episode to the next episode’s newest file', () => {
    const d = detail([mediaFile(42, 1), mediaFile(88, 1, { status: 'pending' }), mediaFile(52, 2), mediaFile(98, 2, { status: 'pending' })]);
    expect(nextFile(d, 88)).toEqual({ fileId: 98, name: 'E2' });
  });
  it('advances from a stale playing row to the next episode’s newest file', () => {
    const d = detail([mediaFile(42, 1), mediaFile(88, 1, { status: 'pending' }), mediaFile(52, 2), mediaFile(98, 2, { status: 'pending' })]);
    expect(nextFile(d, 42)).toEqual({ fileId: 98, name: 'E2' });
  });
  it('never navigates to extras', () => {
    const d = detail([mediaFile(11, 1), mediaFile(20, 2, { extraLabel: 'OP' }), mediaFile(13, 3)]);
    expect(nextFile(d, 11)).toEqual({ fileId: 13, name: 'E3' });
  });
  it('orders by episode number, not array order', () => {
    const d = detail([mediaFile(12, 2), mediaFile(11, 1)], [episode(2, 2, 'E2'), episode(1, 1, 'E1')]);
    expect(nextFile(d, 11)).toEqual({ fileId: 12, name: 'E2' });
  });
  it('returns null at the end and for unknown files', () => {
    const d = detail([mediaFile(11, 1), mediaFile(12, 2)]);
    expect(nextFile(d, 12)).toBeNull();
    expect(nextFile(d, 999)).toBeNull();
  });
});
