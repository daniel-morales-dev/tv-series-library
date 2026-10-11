import { describe, expect, it } from 'vitest';
import { guardRedirect, submitError, suggestedFolder } from './config.ts';

describe('guardRedirect', () => {
  it('unset never forces the wizard (development folder from .env keeps working)', () => {
    expect(guardRedirect('unset', '/browse')).toBeNull();
    expect(guardRedirect('unset', '/')).toBeNull();
    expect(guardRedirect('unset', '/setup')).toBeNull();
  });

  it('missing also lands on setup, which shows the missing-folder error', () => {
    expect(guardRedirect('missing', '/watch/3')).toBe('/setup');
    expect(guardRedirect('missing', '/setup')).toBeNull();
  });

  it('ready keeps the normal flow and bounces away from the wizard', () => {
    expect(guardRedirect('ready', '/browse')).toBeNull();
    expect(guardRedirect('ready', '/settings')).toBeNull();
    expect(guardRedirect('ready', '/setup')).toBe('/');
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
