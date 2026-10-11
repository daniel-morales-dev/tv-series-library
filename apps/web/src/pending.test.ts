import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';
import { candidateLabel, fileName, parsedLabel, pendingErrorLabel, pendingReasonLabel } from './pending.ts';

describe('pending labels', () => {
  it('translates the reason codes the server stores', () => {
    expect(pendingReasonLabel('no_match')).toBe('No se encontró la serie en TMDB');
    expect(pendingReasonLabel('unmapped_episode')).toBe('Episodio sin ubicación en las temporadas');
    expect(pendingReasonLabel('unparsed')).toBe('Nombre de archivo no reconocido');
  });

  it('falls back for a reason it does not know', () => {
    expect(pendingReasonLabel('something_new')).toBe('Motivo desconocido');
  });

  it('turns the confirm error codes into Spanish', () => {
    expect(pendingErrorLabel(new Error('unmapped_episode'))).toBe('El episodio no existe en las temporadas de esa serie.');
    expect(pendingErrorLabel(new Error('not_found'))).toBe('Este archivo ya no está pendiente.');
  });

  it('keeps a real server message and replaces a bare status', () => {
    expect(pendingErrorLabel(new Error('El archivo ya no existe en disco.'))).toBe('El archivo ya no existe en disco.');
    expect(pendingErrorLabel(new Error('502'))).toBe('No se pudo completar la acción.');
    expect(pendingErrorLabel('not an error')).toBe('No se pudo completar la acción.');
  });

  it('describes what the parser saw', () => {
    expect(parsedLabel({ kind: 'episode', show: 'Frieren', season: 3, number: 5 })).toBe('T3E5 · Frieren');
    expect(parsedLabel({ kind: 'episode', show: 'Frieren', season: null, number: 12 })).toBe('E12 · Frieren');
    expect(parsedLabel({ kind: 'movie', title: 'Dune', year: 2021 })).toBe('Película · Dune');
    expect(parsedLabel({ kind: 'extra', show: 'Frieren', label: 'OP1' })).toBe('Extra · OP1');
    expect(parsedLabel({ kind: 'unparsed' })).toBeNull();
  });

  it('shows the file name and the candidate label', () => {
    expect(fileName('Frieren/S03/Frieren.S03E05.mkv')).toBe('Frieren.S03E05.mkv');
    expect(candidateLabel({ tmdbType: 'tv', tmdbId: 1, title: 'Frieren', originalTitle: 'Sousou no Frieren', year: 2023, overview: null })).toBe(
      'Frieren (2023)',
    );
  });
});

describe('pending api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the open pending files', async () => {
    const rows = [
      {
        id: 3,
        path: 'Frieren/S03/Frieren.S03E05.mkv',
        size: 100,
        parsed: { kind: 'episode', show: 'Frieren', season: 3, number: 5 },
        reason: 'unmapped_episode',
        candidates: [],
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.pending()).resolves.toEqual(rows);
    expect(fetchMock).toHaveBeenCalledWith('/api/pending', undefined);
  });

  it('confirms with the chosen TMDB match', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ titleId: 9, placed: 4 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.confirmPending(3, { tmdbType: 'tv', tmdbId: 42 })).resolves.toEqual({ titleId: 9, placed: 4 });
    expect(fetchMock).toHaveBeenCalledWith('/api/pending/3/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tmdbType: 'tv', tmdbId: 42 }),
    });
  });

  it('ignores a pending file', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.ignorePending(3)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/pending/3/ignore', { method: 'POST' });
  });
});
