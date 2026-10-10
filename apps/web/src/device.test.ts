import { describe, expect, it } from 'vitest';
import { fullscreenMode, isIOS, isMobile, volumeWritable } from './device.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

describe('isIOS', () => {
  it('detects iPhone/iPad user agents', () => expect(isIOS(IPHONE, 'iPhone', 5)).toBe(true));
  it('detects iPadOS posing as a Mac', () => expect(isIOS(DESKTOP, 'MacIntel', 5)).toBe(true));
  it('is false for a real Mac, Android and Linux', () => {
    expect(isIOS(DESKTOP, 'MacIntel', 0)).toBe(false);
    expect(isIOS(ANDROID, 'Linux armv8l', 5)).toBe(false);
    expect(isIOS(DESKTOP, 'Linux x86_64', 0)).toBe(false);
  });
});

describe('isMobile', () => {
  it('is true for phones and tablets', () => {
    expect(isMobile(IPHONE, 'iPhone', 5)).toBe(true);
    expect(isMobile(ANDROID, 'Linux armv8l', 5)).toBe(true);
  });
  it('is false for desktop', () => expect(isMobile(DESKTOP, 'Linux x86_64', 0)).toBe(false));
});

describe('volumeWritable', () => {
  it('is true when the element keeps the written volume, and restores it', () => {
    const el = { volume: 1 };
    expect(volumeWritable(el)).toBe(true);
    expect(el.volume).toBe(1);
  });
  it('is false when writes are ignored (iOS)', () => {
    const el = Object.defineProperty({}, 'volume', { get: () => 1, set: () => {} }) as { volume: number };
    expect(volumeWritable(el)).toBe(false);
  });
});

describe('fullscreenMode', () => {
  it('uses the native player on iOS and our container elsewhere', () => {
    expect(fullscreenMode(true)).toBe('native');
    expect(fullscreenMode(false)).toBe('container');
  });
});
