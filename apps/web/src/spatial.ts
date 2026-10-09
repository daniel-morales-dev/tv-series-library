import type { Router } from 'vue-router';

export type Direction = 'up' | 'down' | 'left' | 'right';
export interface Rect { left: number; top: number; right: number; bottom: number }

const BACK_KEYS = new Set(['Escape', 'Backspace', 'GoBack', 'BrowserBack']);
/** Back on a TV remote: `Escape`/`Backspace`/`GoBack` depending on the browser, keyCode 461 (webOS/Google TV) or 10009 (Tizen). */
export const isBackKey = (e: Pick<KeyboardEvent, 'key' | 'keyCode'>): boolean =>
  BACK_KEYS.has(e.key) || e.keyCode === 461 || e.keyCode === 10009;

const PERP_WEIGHT = 2;
const ROW_TOLERANCE = 8;
const mid = (a: number, b: number) => (a + b) / 2;
const cx = (r: Rect) => mid(r.left, r.right);
const cy = (r: Rect) => mid(r.top, r.bottom);
const inside = (x: number, y: number, r: Rect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/**
 * The best element to move to from `from` in `dir`: the one ahead that is closest along that axis,
 * penalising sideways drift (so aligned items beat nearer diagonal ones). Sideways moves with nothing ahead
 * wrap to the adjacent row, so the end of a row leads to the start of the next.
 */
export function pickNext<T extends Rect>(from: Rect, candidates: readonly T[], dir: Direction): T | null {
  const horizontal = dir === 'left' || dir === 'right';
  const fx = cx(from);
  const fy = cy(from);
  let best: T | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const x = cx(c);
    const y = cy(c);
    const ahead = { right: x > fx, left: x < fx, down: y > fy, up: y < fy }[dir];
    if (!ahead) continue;
    if (horizontal && (inside(x, y, from) || inside(fx, fy, c))) continue; // a control nested in the origin (or its container)
    const primary = { right: c.left - from.right, left: from.left - c.right, down: c.top - from.bottom, up: from.top - c.bottom }[dir];
    const [lo, hi, at, off] = horizontal ? [c.top, c.bottom, fy, Math.abs(y - fy)] : [c.left, c.right, fx, Math.abs(x - fx)];
    const perp = at < lo ? lo - at : at > hi ? at - hi : 0;
    const score = Math.max(0, primary) + PERP_WEIGHT * perp + off / 1000;
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best ?? (horizontal ? wrap(from, candidates, dir === 'right') : null);
}

function wrap<T extends Rect>(from: Rect, candidates: readonly T[], forward: boolean): T | null {
  const height = from.bottom - from.top;
  const rows = candidates.filter((c) => (forward ? cy(c) > from.bottom && c.top - from.bottom < height : cy(c) < from.top && from.top - c.bottom < height));
  if (!rows.length) return null;
  const rowOf = (c: T) => (forward ? c.top : -c.bottom);
  const first = Math.min(...rows.map(rowOf));
  const inRow = rows.filter((c) => rowOf(c) - first <= ROW_TOLERANCE);
  return inRow.reduce((a, b) => ((forward ? b.left < a.left : b.right > a.right) ? b : a));
}

// ---- DOM wiring ----

const FOCUSABLE = 'a[href], button, input, select, [tabindex]:not([tabindex="-1"])';
const SCOPES = '[aria-modal="true"], [role="menu"]';
const AUTOFOCUS = '[data-autofocus], .poster-grid a[href], .list-grid a[href], .scroller a[href]';
const DIRECTIONS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

const isTextField = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type));

function usable(el: HTMLElement): boolean {
  if (el.tabIndex < 0 || el.matches(':disabled') || el.closest('[inert], [hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

const openScope = () => [...document.querySelectorAll<HTMLElement>(SCOPES)].reverse().find(usable) ?? null;

/** Arrow-key (TV remote) focus movement, initial focus per page and the Back key. */
export function installSpatialNav(router: Router): void {
  const onWatch = () => router.currentRoute.value.path.startsWith('/watch'); // the player owns its keys
  let last: HTMLElement | null = null;
  document.addEventListener('focusin', (e) => (last = e.target as HTMLElement));
  // Last input modality: a keyboard/remote user gets automatic focus (and its ring); a mouse/touch user never does.
  let keyboard = false;
  for (const t of ['pointerdown', 'mousedown', 'touchstart']) window.addEventListener(t, () => (keyboard = false), true);
  window.addEventListener('keydown', (e) => !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key) && (keyboard = true), true);

  function candidates(scope: ParentNode, active: HTMLElement | null) {
    const mine = active?.closest('article');
    return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((el) => el !== active && usable(el) && (!el.closest('[data-spatial-skip]') || (mine && mine.contains(el))))
      .map((el) => Object.assign(el.getBoundingClientRect().toJSON() as Rect, { el }));
  }
  const focusEl = (el: HTMLElement) => {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  function move(dir: Direction, e: KeyboardEvent) {
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const scope = openScope() ?? document;
    if (!active) {
      const back = last && last.isConnected && usable(last) && scope.contains(last) ? last : null;
      const primary = [...scope.querySelectorAll<HTMLElement>(AUTOFOCUS)].find(usable);
      const first = back ?? primary ?? candidates(scope, null).find((c) => c.top >= 0 && c.bottom <= innerHeight)?.el;
      if (first) (e.preventDefault(), focusEl(first));
      return;
    }
    const next = pickNext(active.getBoundingClientRect(), candidates(scope, active), dir);
    if (next) (e.preventDefault(), focusEl(next.el));
    else if (dir !== 'left' && dir !== 'right') e.preventDefault(); // keep the page from scrolling under the focus
  }

  function onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || onWatch()) return;
    const target = e.target;
    if (isBackKey(e)) {
      const path = router.currentRoute.value.path;
      if (path === '/' || path === '/browse' || isTextField(target) || target instanceof HTMLSelectElement || openScope()) return;
      e.preventDefault();
      if (window.history.state?.back) router.back();
      else void router.push('/browse');
      return;
    }
    const dir = DIRECTIONS[e.key];
    if (!dir) return;
    if (target instanceof HTMLTextAreaElement) return;
    if (isTextField(target)) {
      if (dir === 'left' || dir === 'right') return; // caret movement
      const sug = dir === 'down' ? document.querySelector<HTMLElement>('[data-suggestions] button') : null;
      if (sug) return void (e.preventDefault(), focusEl(sug));
    }
    if (target instanceof HTMLSelectElement && (dir === 'up' || dir === 'down')) return; // native option picking
    move(dir, e);
  }
  window.addEventListener('keydown', onKey);

  // Initial focus: once the page has rendered its primary action (data loads async), unless the user already moved focus.
  let watcher: MutationObserver | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  function seekFocus() {
    watcher?.disconnect();
    clearTimeout(timeout);
    if (onWatch()) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (!keyboard) return; // pointer user: don't steal focus or draw a ring; the first arrow key will focus the primary action
    const done = () => (watcher?.disconnect(), clearTimeout(timeout));
    const attempt = () => {
      if (document.activeElement && document.activeElement !== document.body) return void done();
      const el = [...document.querySelectorAll<HTMLElement>(AUTOFOCUS)].find(usable);
      if (el) (el.focus({ preventScroll: true }), done());
    };
    attempt();
    if (document.activeElement && document.activeElement !== document.body) return;
    watcher = new MutationObserver(attempt);
    watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'class', 'style'] });
    timeout = setTimeout(done, 5000);
  }
  router.afterEach((to, from, failure) => {
    if (!failure && to.path !== from.path) seekFocus();
  });
  void router.isReady().then(seekFocus);
}
