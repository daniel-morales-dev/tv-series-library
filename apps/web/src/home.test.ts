import { describe, expect, it } from 'vitest';
import { emptyLibraryHint, type AppConfig } from './config.ts';

const config = (status: AppConfig['status'], contentDir: string | null = null): AppConfig => ({
  status,
  contentDir,
  libraryId: status === 'ready' ? 'lib-1' : null,
  suggestedDefault: '/home/usuario/series',
});

describe('emptyLibraryHint', () => {
  it('unset tells the user to pick the folder first and points at the wizard', () => {
    const hint = emptyLibraryHint(config('unset'));
    expect(hint.title).toBe('Tu biblioteca está vacía');
    expect(hint.body).toBe('Antes de nada, elige la carpeta donde vivirán tus archivos.');
    expect(hint.action).toEqual({ label: 'Configurar carpeta', to: '/setup' });
    expect(hint.link).toBeNull();
  });

  it('missing follows the same branch: the wizard explains the absent folder', () => {
    expect(emptyLibraryHint(config('missing', 'D:\\Media'))).toEqual(emptyLibraryHint(config('unset')));
  });

  it('ready names the shows/ and films/ folders under the real path and links to settings', () => {
    const hint = emptyLibraryHint(config('ready', 'D:\\Media'));
    expect(hint.body).toContain('D:\\Media/shows');
    expect(hint.body).toContain('D:\\Media/films');
    expect(hint.action).toBeNull();
    expect(hint.link).toEqual({ label: 'Cambiar carpeta', to: '/settings' });
  });

  it('ready trims a trailing slash so the instruction reads cleanly', () => {
    expect(emptyLibraryHint(config('ready', '/media/tv/')).body).toContain('/media/tv/shows');
  });

  it('an unreachable config falls back to the configure step instead of a dead end', () => {
    expect(emptyLibraryHint(null).action).toEqual({ label: 'Configurar carpeta', to: '/setup' });
  });
});
