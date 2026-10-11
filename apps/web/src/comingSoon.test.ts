import { renderToString } from 'vue/server-renderer';
import { createSSRApp, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, playErrorMessage } from './api.ts';
import ExtraCard from './components/ExtraCard.vue';
import ListCard from './components/ListCard.vue';
import TitleCard from './components/TitleCard.vue';
import { fileStatus, needsPolling } from './fileStatus.ts';
import { firstFileId } from './library.ts';
import { buildEpisodes, isPlayable, playPlan } from './titlePage.ts';
import type { MediaFile, TitleDetail, TitleSummary } from './types.ts';

const summary = (comingSoon: boolean): TitleSummary => ({
  id: 1, kind: 'anime', title: 'Frieren', originalTitle: null, overview: null, year: 2023, runtimeMin: null, rating: null,
  genres: [], posterPath: null, backdropPath: null, logoPath: null, comingSoon,
});
const file = (id: number, episodeId: number | null, status: MediaFile['status'] = 'ready'): MediaFile => ({
  id, status, episodeId, extraLabel: null, durationS: null, audioTracks: [], subtitleTracks: [],
});
const ep = (id: number, number: number) => ({ id, number, name: null, overview: null, runtimeMin: null, stillPath: null, airDate: null });
const detail = (comingSoon: boolean, files: MediaFile[]): TitleDetail =>
  ({ ...summary(comingSoon), seasons: [{ id: 1, number: 1, name: null, episodes: [ep(1, 1), ep(2, 2)] }], files, credits: [], progress: [] });

const RouterLink = (_: unknown, { slots }: { slots: { default?: () => never } }) => h('a', slots.default?.());
const html = (c: object, props: object) => renderToString(createSSRApp({ render: () => h(c, props) }).component('RouterLink', RouterLink));

describe('Próximamente badge', () => {
  it('shows on TitleCard and ListCard only when comingSoon', async () => {
    expect(await html(TitleCard, { title: summary(true) })).toContain('Próximamente');
    expect(await html(TitleCard, { title: summary(false) })).not.toContain('Próximamente');
    expect(await html(ListCard, { title: summary(true) })).toContain('Próximamente');
    expect(await html(ListCard, { title: summary(false) })).not.toContain('Próximamente');
  });
});

describe('downloading files', () => {
  it('has a "descargando" status and keeps polling', () => {
    expect(fileStatus(file(1, 1, 'downloading'), [])).toEqual({ kind: 'downloading', label: 'descargando' });
    expect(needsPolling([file(1, 1, 'downloading')])).toBe(true);
  });
  it('isPlayable is false only for downloading', () => {
    expect(isPlayable(file(1, 1, 'downloading'))).toBe(false);
    expect(isPlayable(file(1, 1, 'pending'))).toBe(true);
    expect(isPlayable(null)).toBe(false);
  });
  it('comingSoon title has no play plan', () => {
    expect(playPlan(detail(true, [file(11, 1, 'downloading'), file(12, 2, 'downloading')]))).toBeNull();
  });
  it('partly downloading title plays the playable episode and skips the downloading one', () => {
    const d = detail(false, [file(11, 1, 'downloading'), file(12, 2)]);
    expect(playPlan(d)).toMatchObject({ fileId: 12 });
    expect(buildEpisodes(d)[0]!.rows[0]!.file!.status).toBe('downloading');
  });
  it('firstFileId never picks a downloading file', () => {
    const files = [file(11, 1, 'downloading')];
    expect(firstFileId({ seasons: detail(true, files).seasons, files })).toBeNull();
    expect(firstFileId({ seasons: [], files: [file(3, null, 'downloading')] })).toBeNull();
  });
  it('firstFileId picks the newest file per episode, not a stale ready one', () => {
    const files = [file(42, 1, 'ready'), file(88, 1, 'pending')];
    expect(firstFileId({ seasons: detail(true, files).seasons, files })).toBe(88);
  });
});

describe('409 downloading', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('api.play maps a 409 downloading body to its own error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'downloading' }), { status: 409 })));
    await expect(api.play(1)).rejects.toThrow('downloading');
  });
  it('playErrorMessage gives the Spanish text', () => {
    expect(playErrorMessage(new Error('downloading'))).toBe('Este episodio aún se está descargando.');
    expect(playErrorMessage(new Error('500'))).toBe('No se pudo preparar el video (500).');
    expect(playErrorMessage(new Error('404'))).toBe('No se pudo cargar el video.');
  });
});

describe('503 disk absent', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('api.play maps the disk_absent 503 body to its own error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'disk_absent' }), { status: 503 })));
    await expect(api.play(1)).rejects.toThrow('disk_absent');
  });
  it('playErrorMessage gives the Spanish text', () => {
    expect(playErrorMessage(new Error('disk_absent'))).toBe(
      'La ubicación de este título no está disponible. Reconecta la ubicación e inténtalo de nuevo.',
    );
  });
});

describe('extras', () => {
  const extra = (status: MediaFile['status']) => ({ ...file(1, null, status), extraLabel: 'NCED 01' });
  it('shows no play icon while downloading, but does when playable', async () => {
    const cardHtml = (f: MediaFile) => html(ExtraCard, { file: f, status: fileStatus(f, []), to: '/watch/1' });
    const downloading = await cardHtml(extra('downloading'));
    expect(downloading).toContain('descargando');
    expect(downloading).not.toContain('<svg');
    expect(await cardHtml(extra('ready'))).toContain('<svg');
  });
});
