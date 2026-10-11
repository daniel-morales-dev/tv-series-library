/** Which player action a keydown maps to, given the focused element. */
export type PlayerKeyAction =
  | 'ignore' // the focused control owns the key: do not preventDefault, do not act
  | 'toggle' // play/pause
  | 'seek-back' // -10 s
  | 'seek-forward' // +10 s
  | 'volume-up'
  | 'volume-down'
  | 'prev-episode'
  | 'next-episode'
  | 'pass'; // nothing the player handles

/** The parts of the event target the routing inspects (real DOM nodes and test doubles both fit). */
export interface KeyTarget {
  tagName?: string;
  type?: string;
}

/** Keys a focused range input uses itself (the seek and volume sliders); the player must leave them alone. */
const SLIDER_KEYS = new Set([' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** T56: dedicated TV-remote keys; like a real remote's transport keys they act wherever focus happens to be. */
const REMOTE_KEYS: Record<string, PlayerKeyAction> = {
  MediaPlayPause: 'toggle',
  MediaPlay: 'toggle',
  MediaPause: 'toggle',
  MediaRewind: 'seek-back',
  MediaFastForward: 'seek-forward',
  ChannelUp: 'prev-episode',
  ChannelDown: 'next-episode',
};

/** The next index in a linear control list (menu items, player chrome), wrapping at both ends. */
export function stepIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}

export function decidePlayerKey(target: KeyTarget | EventTarget | null, key: string): PlayerKeyAction {
  const remote = REMOTE_KEYS[key];
  if (remote) return remote;
  const el = target as KeyTarget | null;
  const tag = el?.tagName?.toUpperCase() ?? '';
  // T51: a slider keeps the keys that adjust it (native range behavior fires `input` → onSeek/onVolume).
  if (tag === 'INPUT' && el?.type === 'range') return SLIDER_KEYS.has(key) ? 'ignore' : 'pass';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'ignore';
  // Space/Enter on a button or link belong to that control.
  if (key === ' ' || key === 'Enter') return tag === 'BUTTON' || tag === 'A' ? 'pass' : 'toggle';
  if (key === 'ArrowLeft') return 'seek-back';
  if (key === 'ArrowRight') return 'seek-forward';
  if (key === 'ArrowUp') return 'volume-up';
  if (key === 'ArrowDown') return 'volume-down';
  return 'pass';
}
