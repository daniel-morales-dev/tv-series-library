import { describe, expect, it } from 'vitest';
import { layoutDiagram, parentIfMediaRoot, pathSeparator, stepLabel, tmdbSkipNote } from './onboarding.ts';

describe('parentIfMediaRoot', () => {
  it('returns the parent when the last segment is shows or films', () => {
    expect(parentIfMediaRoot('C:\\Users\\ana\\Videos\\Sala\\shows')).toBe('C:\\Users\\ana\\Videos\\Sala');
    expect(parentIfMediaRoot('/home/ana/Videos/Sala/films')).toBe('/home/ana/Videos/Sala');
  });

  it('ignores case and trailing separators', () => {
    expect(parentIfMediaRoot('/data/Sala/SHOWS/')).toBe('/data/Sala');
    expect(parentIfMediaRoot('D:\\Sala\\Films\\\\')).toBe('D:\\Sala');
  });

  it('returns null for any other folder', () => {
    expect(parentIfMediaRoot('/home/ana/Videos/Sala')).toBeNull();
    expect(parentIfMediaRoot('/home/ana/my-shows')).toBeNull();
    expect(parentIfMediaRoot('')).toBeNull();
  });

  it('returns null when there is no parent to suggest', () => {
    expect(parentIfMediaRoot('shows')).toBeNull();
    expect(parentIfMediaRoot('/shows')).toBeNull();
  });
});

describe('pathSeparator', () => {
  it('uses a backslash only when the suggested path has one', () => {
    expect(pathSeparator('C:\\Users\\ana\\Videos\\Sala')).toBe('\\');
    expect(pathSeparator('/home/ana/Videos/Sala')).toBe('/');
    expect(pathSeparator('')).toBe('/');
  });
});

describe('layoutDiagram', () => {
  it('draws the Sala layout with the given separator', () => {
    const text = layoutDiagram('\\');
    expect(text).toContain('Sala\\');
    expect(text).toContain('shows\\');
    expect(text).toContain('films\\');
    expect(text.split('\n')).toHaveLength(3);
  });
});

describe('stepLabel', () => {
  it('numbers the steps out of three', () => {
    expect(stepLabel(2)).toBe('Paso 2 de 3');
  });
});

describe('tmdbSkipNote', () => {
  it('explains what is lost without a token', () => {
    expect(tmdbSkipNote).toMatch(/nombre del archivo/);
    expect(tmdbSkipNote).toMatch(/Ajustes/);
  });
});
