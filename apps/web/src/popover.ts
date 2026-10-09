export interface Box { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }

const GAP = 6;
const EDGE = 8;

/** Fixed position for a menu under `anchor`, right-aligned, flipped upward and clamped to fit the viewport. */
export function popoverPosition(anchor: Box, menu: Size, vp: Size): { left: number; top: number } {
  const below = anchor.bottom + GAP;
  const top = below + menu.height + EDGE > vp.height ? Math.max(EDGE, anchor.top - menu.height - GAP) : below;
  const left = Math.min(Math.max(EDGE, anchor.right - menu.width), vp.width - menu.width - EDGE);
  return { left, top };
}
