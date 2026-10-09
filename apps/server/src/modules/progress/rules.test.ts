import { describe, expect, it } from 'vitest';
import { isCompleted, resolveContinueTarget, type PlayableFile } from './rules.ts';

describe('isCompleted', () => {
  it('is true at exactly 90% and above', () => {
    expect(isCompleted(90, 100)).toBe(true);
    expect(isCompleted(100, 100)).toBe(true);
  });
  it('is false below 90% or with no duration', () => {
    expect(isCompleted(89.9, 100)).toBe(false);
    expect(isCompleted(10, 0)).toBe(false);
  });
});

const f = (mediaFileId: number, completed = false, positionS = 0): PlayableFile => ({ mediaFileId, completed, positionS });

describe('resolveContinueTarget', () => {
  it('resumes the same file when not completed', () => {
    const ordered = [f(1, true), f(2), f(3)];
    expect(resolveContinueTarget({ mediaFileId: 2, positionS: 40, completed: false }, ordered)).toEqual({
      mediaFileId: 2,
      positionS: 40,
    });
  });

  it('moves to the next uncompleted file when the latest is completed', () => {
    const ordered = [f(1, true), f(2, true), f(3, true), f(4)];
    expect(resolveContinueTarget({ mediaFileId: 2, positionS: 95, completed: true }, ordered)).toEqual({
      mediaFileId: 4,
      positionS: 0,
    });
  });

  it('resumes the next file at its own saved position', () => {
    const ordered = [f(1, true), f(2, false, 30)];
    expect(resolveContinueTarget({ mediaFileId: 1, positionS: 95, completed: true }, ordered)).toEqual({
      mediaFileId: 2,
      positionS: 30,
    });
  });

  it('returns null when nothing is left to watch', () => {
    expect(resolveContinueTarget({ mediaFileId: 2, positionS: 95, completed: true }, [f(1, true), f(2, true)])).toBeNull();
    expect(resolveContinueTarget({ mediaFileId: 1, positionS: 95, completed: true }, [f(1, true)])).toBeNull();
  });

  it('starts from the first uncompleted file when the latest is not in the list (e.g. an extra)', () => {
    expect(resolveContinueTarget({ mediaFileId: 99, positionS: 95, completed: true }, [f(1, true), f(2)])).toEqual({
      mediaFileId: 2,
      positionS: 0,
    });
  });
});
