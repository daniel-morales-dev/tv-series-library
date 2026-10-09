export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const KEY = 'playbackSpeed';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const speedLabel = (s: number): string => `${String(s).replace('.', ',')}×`;

export function loadSpeed(store: Store = localStorage): number {
  try {
    const v = Number(store.getItem(KEY));
    return SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveSpeed(s: number, store: Store = localStorage): void {
  try {
    store.setItem(KEY, String(s));
  } catch {
    // private mode / blocked storage: the speed just isn't remembered
  }
}
