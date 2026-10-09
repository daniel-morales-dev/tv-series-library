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
