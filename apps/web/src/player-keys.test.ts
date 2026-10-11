import { describe, expect, it } from 'vitest';
import { decidePlayerKey } from './player-keys.ts';

const target = (tagName: string, type?: string) => ({ tagName, type });

describe('decidePlayerKey', () => {
  it('lets a focused slider keep the keys that adjust it', () => {
    for (const key of [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(decidePlayerKey(target('INPUT', 'range'), key)).toBe('ignore');
    }
  });
  it('keeps the back key for the player while the slider is focused', () =>
    expect(decidePlayerKey(target('INPUT', 'range'), 'Escape')).toBe('pass'));
  it('ignores text fields and selects', () => {
    expect(decidePlayerKey(target('INPUT', 'text'), ' ')).toBe('ignore');
    expect(decidePlayerKey(target('TEXTAREA'), 'ArrowLeft')).toBe('ignore');
    expect(decidePlayerKey(target('SELECT'), 'Enter')).toBe('ignore');
  });
  it('toggles play on Space or Enter', () => {
    expect(decidePlayerKey(target('BODY'), ' ')).toBe('toggle');
    expect(decidePlayerKey(target('VIDEO'), 'Enter')).toBe('toggle');
  });
  it('leaves Space/Enter on a button or link to that control', () => {
    expect(decidePlayerKey(target('BUTTON'), ' ')).toBe('pass');
    expect(decidePlayerKey(target('A'), 'Enter')).toBe('pass');
  });
  it('seeks with Left/Right', () => {
    expect(decidePlayerKey(target('BODY'), 'ArrowLeft')).toBe('seek-back');
    expect(decidePlayerKey(target('BODY'), 'ArrowRight')).toBe('seek-forward');
  });
  it('adjusts the volume with Up/Down', () => {
    expect(decidePlayerKey(target('BODY'), 'ArrowUp')).toBe('volume-up');
    expect(decidePlayerKey(target('BODY'), 'ArrowDown')).toBe('volume-down');
  });
  it('passes anything else', () => {
    expect(decidePlayerKey(target('BODY'), 'x')).toBe('pass');
    expect(decidePlayerKey(null, 'x')).toBe('pass');
  });
});
