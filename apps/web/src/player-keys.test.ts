import { describe, expect, it } from 'vitest';
import { decidePlayerKey, stepIndex } from './player-keys.ts';

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
  it('toggles fullscreen with f/F, except in fields and sliders', () => {
    expect(decidePlayerKey(target('BODY'), 'f')).toBe('toggle-fullscreen');
    expect(decidePlayerKey(target('VIDEO'), 'F')).toBe('toggle-fullscreen');
    expect(decidePlayerKey(target('BUTTON'), 'f')).toBe('toggle-fullscreen');
    expect(decidePlayerKey(target('INPUT', 'range'), 'f')).toBe('pass');
    expect(decidePlayerKey(target('INPUT', 'text'), 'f')).toBe('ignore');
  });
});

describe('decidePlayerKey remote keys', () => {
  it('toggles on the media transport keys, wherever focus is', () => {
    for (const key of ['MediaPlayPause', 'MediaPlay', 'MediaPause']) {
      expect(decidePlayerKey(target('BODY'), key)).toBe('toggle');
      expect(decidePlayerKey(target('BUTTON'), key)).toBe('toggle');
      expect(decidePlayerKey(target('INPUT', 'range'), key)).toBe('toggle');
    }
  });
  it('seeks with the rewind and fast-forward keys', () => {
    expect(decidePlayerKey(target('BODY'), 'MediaRewind')).toBe('seek-back');
    expect(decidePlayerKey(target('BODY'), 'MediaFastForward')).toBe('seek-forward');
  });
  it('zaps episodes with the channel keys', () => {
    expect(decidePlayerKey(target('BODY'), 'ChannelUp')).toBe('prev-episode');
    expect(decidePlayerKey(target('BODY'), 'ChannelDown')).toBe('next-episode');
  });
});

describe('stepIndex', () => {
  it('steps forward and backward, wrapping at both ends', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, -1)).toBe(0);
  });
  it('stays put on a single-item list and survives an empty one', () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, -1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});
