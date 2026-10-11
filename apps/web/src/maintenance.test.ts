import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, errorText } from './api.ts';
import { reanalyzeSummary, subtitleSummary } from './maintenance.ts';

describe('maintenance summaries', () => {
  it('lists the reanalyze counters, singular when one, zeros left out', () => {
    expect(
      reanalyzeSummary({ scanned: 104, reparsed: 0, replaced: 0, missing: 0, promoted: 0, placed: 38, pending: 0, reseasoned: 1 }),
    ).toBe('104 revisados · 38 recolocados · 1 temporada reorganizada');
    expect(
      reanalyzeSummary({ scanned: 2, reparsed: 1, replaced: 1, missing: 1, promoted: 0, placed: 1, pending: 3, reseasoned: 0 }),
    ).toBe('2 revisados · 1 recolocado · 1 carpeta reasignada · 1 reemplazado · 1 ya no está en disco · 3 pendientes');
  });

  it('says nothing changed when every counter is zero', () => {
    expect(reanalyzeSummary({ scanned: 0, reparsed: 0, replaced: 0, missing: 0, promoted: 0, placed: 0, pending: 0, reseasoned: 0 })).toBe(
      'Sin cambios.',
    );
  });

  it('summarizes the subtitle repair', () => {
    expect(subtitleSummary({ checked: 12, fixed: 3 })).toBe('12 revisados · 3 reparados');
    expect(subtitleSummary({ checked: 1, fixed: 0 })).toBe('1 revisado · sin cambios');
    expect(subtitleSummary({ checked: 0, fixed: 0 })).toBe('No había subtítulos que revisar.');
  });

  it('replaces a bare status with the view fallback', () => {
    expect(errorText(new Error('500'), 'No se pudo re-analizar.')).toBe('No se pudo re-analizar.');
    expect(errorText(new Error('El disco no está conectado.'), 'No se pudo re-analizar.')).toBe('El disco no está conectado.');
  });
});

describe('maintenance api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reanalyzes the whole library with the empty body the server requires', async () => {
    const summary = { scanned: 1, reparsed: 0, replaced: 0, missing: 0, promoted: 0, placed: 0, pending: 0, reseasoned: 0 };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(summary), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.reanalyze()).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith('/api/library/reanalyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('scopes the reanalysis to one title', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.reanalyze(7);
    expect(fetchMock).toHaveBeenCalledWith('/api/library/reanalyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ titleId: 7 }),
    });
  });

  it('repairs every subtitle with the empty body the server requires', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ checked: 4, fixed: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.reprocessSubtitles()).resolves.toEqual({ checked: 4, fixed: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/maintenance/reprocess-subtitles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });
});

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
