import { describe, expect, it } from 'vitest';
import { SPEEDS, loadSpeed, saveSpeed, speedLabel } from './speed.ts';

const store = (initial?: string) => {
  const data = new Map<string, string>(initial ? [['playbackSpeed', initial]] : []);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('speed', () => {
  it('offers 0.5x to 2x', () => expect(SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]));
  it('labels with a comma and the multiplication sign', () => {
    expect(speedLabel(1)).toBe('1×');
    expect(speedLabel(1.25)).toBe('1,25×');
  });
  it('loads the saved speed and falls back to 1', () => {
    expect(loadSpeed(store('1.5'))).toBe(1.5);
    expect(loadSpeed(store())).toBe(1);
    expect(loadSpeed(store('3'))).toBe(1);
    expect(loadSpeed(store('abc'))).toBe(1);
  });
  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadSpeed(broken)).toBe(1);
    expect(() => saveSpeed(2, broken)).not.toThrow();
  });
  it('round-trips', () => {
    const s = store();
    saveSpeed(0.75, s);
    expect(loadSpeed(s)).toBe(0.75);
  });
});
