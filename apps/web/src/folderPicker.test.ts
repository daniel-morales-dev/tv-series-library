import { describe, expect, it } from 'vitest';
import { crumbs, pickerError, startPath } from './folderPicker.ts';

describe('crumbs', () => {
  it('splits an absolute path into cumulative links, starting at the root', () => {
    expect(crumbs('/home/ana/series')).toEqual([
      { name: 'Raíz', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'ana', path: '/home/ana' },
      { name: 'series', path: '/home/ana/series' },
    ]);
  });

  it('the root is a single crumb', () => {
    expect(crumbs('/')).toEqual([{ name: 'Raíz', path: '/' }]);
  });

  it('ignores doubled and trailing slashes', () => {
    expect(crumbs('/mnt//disk/')).toEqual([
      { name: 'Raíz', path: '/' },
      { name: 'mnt', path: '/mnt' },
      { name: 'disk', path: '/mnt/disk' },
    ]);
  });
});

describe('startPath', () => {
  it('opens at the typed path when absolute, else lets the server pick home', () => {
    expect(startPath('  /mnt/disk ')).toBe('/mnt/disk');
    expect(startPath('series')).toBeUndefined();
    expect(startPath('')).toBeUndefined();
  });
});

describe('pickerError', () => {
  it('maps server codes to Spanish', () => {
    expect(pickerError('not_found')).toBe('Esa carpeta no existe.');
    expect(pickerError('forbidden')).toBe('No hay permiso para abrir esa carpeta.');
    expect(pickerError('not_directory')).toBe('Esa ruta es un archivo, no una carpeta.');
    expect(pickerError('500')).toBe('No se pudo leer esa carpeta. Intenta de nuevo.');
  });
});
