import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canAnchor, isBackKey, openScope, pickNext, type Rect } from './spatial.ts';

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

describe('canAnchor', () => {
  it('anchors arrow navigation on real focusables', () => {
    expect(canAnchor({ tabIndex: 0 })).toBe(true);
  });
  it('rejects body, #app and scope roots: tabindex="-1" anchors exist only to receive keys', () => {
    expect(canAnchor({ tabIndex: -1 })).toBe(false);
    expect(canAnchor(null)).toBe(false);
    expect(canAnchor(undefined)).toBe(false);
  });
});

describe('pickNext with a full-page origin', () => {
  it('finds nothing sideways when the origin contains every candidate (why #app must not anchor)', () => {
    const page = box(0, 0, 1920, 1080);
    expect(pickNext(page, [box(100, 100)], 'right')).toBeNull();
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

describe('openScope (T56)', () => {
  // Minimal stand-in for the browser: `matches` understands only the simple `[attr]` / `[attr="value"]` forms
  // used by the scope selector, so openScope can run without a DOM.
  type FakeEl = HTMLElement & { attrs: Record<string, string> };
  const fakeEl = (attrs: Record<string, string>, w = 10, h = 10): FakeEl =>
    ({
      attrs,
      matches: (sel: string) =>
        sel.split(',').some((part) => {
          const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part.trim());
          return !!m && attrs[m[1]!] !== undefined && (m[2] === undefined || attrs[m[1]!] === m[2]);
        }),
      closest: () => null,
      getBoundingClientRect: () => ({ width: w, height: h }),
    }) as unknown as FakeEl;
  const fakeRoot = (els: FakeEl[]): ParentNode =>
    ({ querySelectorAll: (sel: string) => els.filter((e) => e.matches(sel)) }) as unknown as ParentNode;

  beforeEach(() => vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' })));
  afterEach(() => vi.unstubAllGlobals());

  it('is null for a visible menu that did not opt in: a generic menu cannot close on Back, so it is not a scope', () => {
    expect(openScope(fakeRoot([fakeEl({ role: 'menu' })]))).toBeNull();
  });

  it('accepts a visible element explicitly marked data-spatial-scope', () => {
    const scope = fakeEl({ 'data-spatial-scope': '' });
    expect(openScope(fakeRoot([scope]))).toBe(scope);
  });

  it('still requires visibility: a marked element that is not visible is not a scope', () => {
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'hidden' }));
    expect(openScope(fakeRoot([fakeEl({ 'data-spatial-scope': '' })]))).toBeNull();
  });

  it('returns the topmost visible scope', () => {
    const under = fakeEl({ 'data-spatial-scope': '' });
    const over = fakeEl({ 'data-spatial-scope': '' });
    expect(openScope(fakeRoot([under, over]))).toBe(over);
  });
});
