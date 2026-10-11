import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';

describe('refreshMetadata', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the title refresh endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.refreshMetadata(7)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/titles/7/refresh-metadata', { method: 'POST' });
  });

  it('throws the Spanish message the server sends on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'tmdb_unavailable', message: 'No se pudo consultar TMDB. Inténtalo de nuevo cuando haya conexión.' }), {
            status: 502,
          }),
      ),
    );
    await expect(api.refreshMetadata(7)).rejects.toThrow('No se pudo consultar TMDB. Inténtalo de nuevo cuando haya conexión.');
  });

  it('throws a Spanish message when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(api.refreshMetadata(7)).rejects.toThrow('No se pudo conectar con el servidor.');
  });
});
