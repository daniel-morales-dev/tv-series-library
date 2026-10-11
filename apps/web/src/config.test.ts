import { describe, expect, it } from 'vitest';
import { guardRedirect, submitError, suggestedFolder } from './config.ts';

describe('guardRedirect', () => {
  const unset = (suggestedDefault: string) => ({ status: 'unset' as const, suggestedDefault });

  it('unset with an existing default folder keeps the development flow', () => {
    expect(guardRedirect(unset('/repo/content'), '/browse')).toBeNull();
    expect(guardRedirect(unset('/repo/content'), '/')).toBeNull();
    expect(guardRedirect(unset('/repo/content'), '/setup')).toBeNull();
  });

  it('unset with no default folder sends a first run to the wizard', () => {
    expect(guardRedirect(unset(''), '/')).toBe('/setup');
    expect(guardRedirect(unset(''), '/browse')).toBe('/setup');
    expect(guardRedirect(unset(''), '/setup')).toBeNull();
  });

  it('missing also lands on setup, which shows the missing-folder error', () => {
    expect(guardRedirect({ status: 'missing', suggestedDefault: '' }, '/watch/3')).toBe('/setup');
    expect(guardRedirect({ status: 'missing', suggestedDefault: '' }, '/setup')).toBeNull();
  });

  it('ready keeps the normal flow and bounces away from the wizard', () => {
    const ready = { status: 'ready' as const, suggestedDefault: '' };
    expect(guardRedirect(ready, '/browse')).toBeNull();
    expect(guardRedirect(ready, '/settings')).toBeNull();
    expect(guardRedirect(ready, '/setup')).toBe('/');
  });
});

describe('submitError', () => {
  it('a missing folder asks for explicit confirmation before creating it', () => {
    expect(submitError('not_found')).toEqual({ kind: 'confirm-create' });
  });

  it('other server codes map to Spanish messages', () => {
    expect(submitError('invalid_path')).toEqual({ kind: 'error', message: 'Escribe la ruta completa de la carpeta (por ejemplo C:\\Users\\tu-usuario\\Videos\\Sala o /home/tu-usuario/Videos/Sala).' });
    expect(submitError('not_directory')).toEqual({ kind: 'error', message: 'Esa ruta es un archivo, no una carpeta.' });
  });

  it('unknown failures fall back to a generic message', () => {
    expect(submitError('500')).toEqual({ kind: 'error', message: 'No se pudo guardar la carpeta. Intenta de nuevo.' });
  });
});

describe('suggestedFolder', () => {
  it('prefers an existing default folder, then the proposed new one, else nothing', () => {
    expect(suggestedFolder({ suggestedDefault: '/repo/content', newLibraryDir: '/home/ana/Videos/Sala' })).toBe('/repo/content');
    expect(suggestedFolder({ suggestedDefault: '', newLibraryDir: 'C:\\Users\\ana\\Videos\\Sala' })).toBe('C:\\Users\\ana\\Videos\\Sala');
    expect(suggestedFolder({ suggestedDefault: '' })).toBe('');
  });
});
