import { describe, expect, it } from 'vitest';
import { fileLanguages, languageName, titleLanguages, uniqueLanguages } from './languages.ts';

describe('languageName', () => {
  it('maps ISO codes to Spanish, capitalised', () => {
    expect(languageName('jpn')).toBe('Japonés');
    expect(languageName('eng')).toBe('Inglés');
    expect(languageName('spa')).toBe('Español');
    expect(languageName('es')).toBe('Español');
  });
  it('falls back for unknown or missing codes', () => {
    expect(languageName(null)).toBe('Desconocido');
    expect(languageName('und')).toBe('Desconocido');
    expect(languageName('!!')).toBe('!!');
  });
});

describe('uniqueLanguages', () => {
  it('deduplicates by name, keeping order', () => {
    expect(uniqueLanguages([{ language: 'spa' }, { language: 'jpn' }, { language: 'es' }])).toEqual(['Español', 'Japonés']);
  });
});

describe('file and title languages', () => {
  const f = (a: string[], s: string[]) => ({
    extraLabel: null,
    audioTracks: a.map((language) => ({ language })),
    subtitleTracks: s.map((language) => ({ language })),
  });
  it('summarises one file', () => {
    expect(fileLanguages(f(['jpn'], ['eng', 'spa']))).toEqual({ audio: ['Japonés'], subs: ['Inglés', 'Español'] });
  });
  it('aggregates main files only', () => {
    const extra = { ...f(['eng'], ['fra']), extraLabel: 'OP' };
    expect(titleLanguages([f(['jpn'], ['eng']), f(['jpn'], ['eng']), extra])).toEqual({ audio: ['Japonés'], subs: ['Inglés'] });
  });
});
