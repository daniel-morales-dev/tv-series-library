import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';

const root = {
  id: 2,
  label: 'HDD',
  path: '/mnt/hdd/series',
  lastKnownPath: '/mnt/hdd/series',
  present: false,
  sameLibrary: true,
  files: 42,
  suggestion: '/media/hdd/series',
};

describe('roots api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the registered locations', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ roots: [root] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.roots()).resolves.toEqual({ roots: [root] });
    expect(fetchMock).toHaveBeenCalledWith('/api/roots', undefined);
  });

  it('adds a location with its path', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ root }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.addRoot('/mnt/hdd/series')).resolves.toEqual({ root });
    expect(fetchMock).toHaveBeenCalledWith('/api/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/mnt/hdd/series' }),
    });
  });

  it('throws the Spanish message when the folder belongs to another library', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'other_library', message: 'Esta carpeta pertenece a otra biblioteca.' }), { status: 409 }),
      ),
    );

    await expect(api.addRoot('/mnt/other')).rejects.toThrow('Esta carpeta pertenece a otra biblioteca.');
  });

  it('relocates a location to its new path', async () => {
    const moved = { ...root, present: true };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ root: moved }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.relocateRoot(2, '/media/hdd/series')).resolves.toEqual({ root: moved });
    expect(fetchMock).toHaveBeenCalledWith('/api/roots/2/relocate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/media/hdd/series' }),
    });
  });

  it('throws the Spanish message when the folder did not move', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'not_moved', message: 'Esa carpeta no contiene esta biblioteca.' }), { status: 409 }),
      ),
    );

    await expect(api.relocateRoot(2, '/media/other')).rejects.toThrow('Esa carpeta no contiene esta biblioteca.');
  });

  it('forgets a location and accepts the empty 204 body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.forgetRoot(2)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/roots/2', { method: 'DELETE' });
  });

  it('refuses to forget the primary location with the server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'primary_root', message: 'La ubicación principal no se puede olvidar.' }), { status: 400 }),
      ),
    );

    await expect(api.forgetRoot(1)).rejects.toThrow('La ubicación principal no se puede olvidar.');
  });

  it('reports an unreachable server in Spanish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(api.roots()).rejects.toThrow('No se pudo conectar con el servidor.');
  });
});
