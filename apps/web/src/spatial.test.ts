import { describe, expect, it } from 'vitest';
import { isBackKey, pickNext, type Rect } from './spatial.ts';

const box = (left: number, top: number, w = 100, h = 100): Rect & { id: string } => ({ id: `${left},${top}`, left, top, right: left + w, bottom: top + h });
const from = box(0, 0);

describe('pickNext', () => {
  it('moves to the nearest item in a straight line', () => {
    const near = box(120, 0);
    const far = box(260, 0);
    expect(pickNext(from, [far, near], 'right')).toBe(near);
    expect(pickNext(near, [from, far], 'left')).toBe(from);
    expect(pickNext(from, [box(0, 130), box(0, 260)], 'down')?.id).toBe('0,130');
    expect(pickNext(box(0, 130), [from], 'up')).toBe(from);
  });

  it('prefers an aligned item over a closer diagonal one', () => {
    const aligned = box(260, 0);
    const diagonal = box(120, 200);
    expect(pickNext(from, [diagonal, aligned], 'right')).toBe(aligned);
  });

  it('takes the nearest diagonal when nothing is aligned', () => {
    const a = box(150, 160);
    const b = box(150, 400);
    expect(pickNext(from, [b, a], 'right')).toBe(a);
  });

  it('ignores items on the wrong side', () => {
    expect(pickNext(from, [box(-200, 0), box(0, -200)], 'right')).toBeNull();
  });

  it('wraps to the start of the next row at the end of a row', () => {
    const rowEnd = box(240, 0);
    const nextRowFirst = box(0, 140);
    const nextRowSecond = box(120, 140);
    expect(pickNext(rowEnd, [nextRowSecond, nextRowFirst], 'right')).toBe(nextRowFirst);
  });

  it('wraps backwards to the end of the previous row', () => {
    const prevRowLast = box(240, 0);
    const prevRowFirst = box(0, 0);
    expect(pickNext(box(0, 140), [prevRowFirst, prevRowLast], 'left')).toBe(prevRowLast);
  });

  it('does not wrap onto a distant block', () => {
    expect(pickNext(box(240, 0), [box(0, 900)], 'right')).toBeNull();
  });

  it('returns null with no candidate', () => {
    expect(pickNext(from, [], 'down')).toBeNull();
  });

  it('skips a nested control when moving sideways', () => {
    const inner = box(10, 60, 30, 30);
    const next = box(130, 0);
    expect(pickNext(from, [inner, next], 'right')).toBe(next);
  });
});

describe('isBackKey', () => {
  const key = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;
  it('accepts the remote and keyboard back keys', () => {
    for (const k of ['Escape', 'Backspace', 'GoBack', 'BrowserBack']) expect(isBackKey(key({ key: k }))).toBe(true);
    expect(isBackKey(key({ key: 'Unidentified', keyCode: 461 }))).toBe(true);
  });
  it('rejects other keys', () => {
    expect(isBackKey(key({ key: 'Enter', keyCode: 13 }))).toBe(false);
  });
});
