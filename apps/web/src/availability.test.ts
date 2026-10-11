import { renderToString } from 'vue/server-renderer';
import { createSSRApp, h } from 'vue';
import { describe, expect, it } from 'vitest';
import ContinueCard from './components/ContinueCard.vue';
import TitleCard from './components/TitleCard.vue';
import { unavailableNotice } from './library.ts';
import type { ContinueItem, TitleSummary } from './types.ts';

const summary = (available?: boolean): TitleSummary => ({
  id: 1, kind: 'series', title: 'Frieren', originalTitle: null, overview: null, year: 2023, runtimeMin: null, rating: null,
  genres: [], posterPath: null, backdropPath: null, logoPath: null, comingSoon: false,
  ...(available === undefined ? {} : { available }),
});
const item = (available: boolean): ContinueItem => ({
  title: summary(available), mediaFileId: 10, positionS: 100, durationS: 1000, season: 1, episode: 2,
  episodeName: 'Der Weg', episodeId: 2, stillPath: null, updatedAt: '',
});

const RouterLink = (_: unknown, { slots }: { slots: { default?: () => never } }) => h('a', slots.default?.());
const html = (c: object, props: object) => renderToString(createSSRApp({ render: () => h(c, props) }).component('RouterLink', RouterLink));

describe('unavailableNotice', () => {
  it('flags only an explicit false and names the fix', () => {
    expect(unavailableNotice(undefined)).toBeNull();
    expect(unavailableNotice(true)).toBeNull();
    expect(unavailableNotice(false)).toEqual({ label: 'No disponible', hint: 'reconecta la ubicación' });
  });
});

describe('unavailable badge', () => {
  it('shows on TitleCard and drops the play action', async () => {
    const rendered = await html(TitleCard, { title: summary(false) });
    expect(rendered).toContain('No disponible');
    expect(rendered).toContain('reconecta la ubicación');
    expect(rendered).not.toContain('aria-label="Reproducir"');
  });

  it('stays off the TitleCard while the server can play it', async () => {
    const rendered = await html(TitleCard, { title: summary(true) });
    expect(rendered).not.toContain('No disponible');
    expect(rendered).toContain('aria-label="Reproducir"');
  });

  it('shows on ContinueCard and hides the play overlay', async () => {
    const rendered = await html(ContinueCard, { item: item(false) });
    expect(rendered).toContain('No disponible');
    expect(rendered).toContain('reconecta la ubicación');
    expect(rendered).not.toContain('class="play"');
  });

  it('stays off the ContinueCard while available', async () => {
    const rendered = await html(ContinueCard, { item: item(true) });
    expect(rendered).not.toContain('No disponible');
    expect(rendered).toContain('class="play"');
  });
});
