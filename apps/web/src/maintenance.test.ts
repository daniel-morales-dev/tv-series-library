import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';

describe('maintenance api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gets the orphan summary', async () => {
    const scan = { count: 2, bytes: 300, dirs: [{ id: 1, bytes: 100 }, { id: 2, bytes: 200 }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(scan), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.orphans()).resolves.toEqual(scan);
    expect(fetchMock).toHaveBeenCalledWith('/api/maintenance/orphans', undefined);
  });

  it('purges with the explicit confirmation the server requires', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ removed: 2, bytesFreed: 300 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.purgeOrphans()).resolves.toEqual({ removed: 2, bytesFreed: 300 });
    expect(fetchMock).toHaveBeenCalledWith('/api/maintenance/purge-orphans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
  });

  it('throws the Spanish message the server sends when the purge is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'confirm_required', message: 'Hace falta confirmar la eliminación de los paquetes huérfanos.' }), {
            status: 400,
          }),
      ),
    );

    await expect(api.purgeOrphans()).rejects.toThrow('Hace falta confirmar la eliminación de los paquetes huérfanos.');
  });
});
