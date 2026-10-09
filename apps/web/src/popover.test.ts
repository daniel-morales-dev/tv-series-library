import { describe, expect, it } from 'vitest';
import { popoverPosition } from './popover.ts';

const vp = { width: 1000, height: 800 };
const menu = { width: 230, height: 100 };
const anchor = (left: number, top: number) => ({ left, top, right: left + 36, bottom: top + 36 });

describe('popoverPosition', () => {
  it('opens below, right-aligned to the button', () => {
    expect(popoverPosition(anchor(500, 200), menu, vp)).toEqual({ left: 306, top: 242 });
  });
  it('flips upward near the bottom edge', () => {
    expect(popoverPosition(anchor(500, 740), menu, vp).top).toBe(740 - 100 - 6);
  });
  it('stays inside the viewport on the left', () => {
    expect(popoverPosition(anchor(10, 200), menu, vp).left).toBe(8);
  });
  it('stays inside the viewport on the right', () => {
    expect(popoverPosition(anchor(990, 200), menu, vp).left).toBe(1000 - 230 - 8);
  });
});
