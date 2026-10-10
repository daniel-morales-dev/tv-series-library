import { describe, expect, it } from 'vitest';
import { parsePath } from './parser.ts';

const bake = (name: string) => `shows/bakemonogatari/[Coalgirls]_Bakemonogatari_${name}_(1920x1080_Blu-ray_FLAC)_[8924213A].mkv`;

describe('parsePath: shows', () => {
  it.each([
    ['01', 1],
    ['09', 9],
    ['15', 15],
  ])('absolute episode %s from the real Bakemonogatari names', (tag, number) => {
    expect(parsePath(bake(tag))).toEqual({ kind: 'episode', show: 'bakemonogatari', season: null, number });
  });

  it.each(['OP2', 'OP4a', 'OP5b', 'ED1', 'ED3', 'PV01', 'PV05', 'PV12'])('extra %s', (label) => {
    expect(parsePath(bake(label))).toEqual({ kind: 'extra', show: 'bakemonogatari', label });
  });

  it.each([
    ['shows/Show/Show S02E05.mkv', 2, 5],
    ['shows/Show/Show.s10e11.1080p.WEB-DL.x265.mkv', 10, 11],
    ['shows/Show/Show - 1x02 - Title.mkv', 1, 2],
    ['shows/Show/Season 3/Show 07.mkv', 3, 7],
  ])('%s', (path, season, number) => {
    expect(parsePath(path)).toEqual({ kind: 'episode', show: 'Show', season, number });
  });

  it('ignores resolution as an episode number', () => {
    expect(parsePath('shows/Show/Show - 05 [1080p x265].mkv')).toMatchObject({ kind: 'episode', number: 5 });
    expect(parsePath('shows/Show/Show 1920x1080.mkv')).toEqual({ kind: 'unparsed' });
  });

  it('recognises other extras', () => {
    expect(parsePath('shows/Show/Show NCOP1.mkv')).toMatchObject({ kind: 'extra', label: 'NCOP1' });
    expect(parsePath('shows/Show/Show NCED.mkv')).toMatchObject({ kind: 'extra', label: 'NCED' });
    expect(parsePath('shows/Show/Show Menu.mkv')).toMatchObject({ kind: 'extra', label: 'Menu' });
  });

  it.each(['NCED 01', 'NCED 02', 'NCED Special', 'NCOP 01', 'NCOP 02'])('keeps the qualifier of creditless extra %s', (label) => {
    const file = `[Cifer] Sousou no Frieren S1 - ${label} [BD 1080P Ma10p Opus].mkv`;
    expect(parsePath(`shows/[Cifer] Sousou no Frieren S1 [BD 1080p Opus]/NC/${file}`)).toMatchObject({ kind: 'extra', label });
  });

  it('derives the show from the file name when it sits directly under shows/', () => {
    expect(parsePath('shows/Some.Show.S01E02.mkv')).toEqual({ kind: 'episode', show: 'Some Show', season: 1, number: 2 });
  });

  describe('trailing season marker on the show name', () => {
    const frieren = (name: string) => `shows/[Cifer] Sousou no Frieren S1 [BD 1080p Opus]/${name}`;

    it('moves the marker from the folder into the episode season', () => {
      expect(parsePath(frieren('[Cifer] Sousou no Frieren S1 - 01 [BD 1080P Ma10p Opus].mkv'))).toEqual({
        kind: 'episode',
        show: 'Sousou no Frieren',
        season: 1,
        number: 1,
      });
    });

    it('strips the marker from extras in NC/ folders', () => {
      expect(parsePath(frieren('NC/[Cifer] Sousou no Frieren S1 - NCED [BD 1080P Ma10p Opus].mkv'))).toEqual({
        kind: 'extra',
        show: 'Sousou no Frieren',
        label: 'NCED',
      });
    });

    it.each([
      ['shows/Show S02/Show - 05.mkv', 2],
      ['shows/Show Season 3/Show - 05.mkv', 3],
      ['shows/Show 2nd Season/Show - 05.mkv', 2],
      ['shows/Show S2 - 05.mkv', 2],
    ])('%s', (path, season) => {
      expect(parsePath(path)).toEqual({ kind: 'episode', show: 'Show', season, number: 5 });
    });

    it('lets an explicit season in the file name win over the marker', () => {
      expect(parsePath('shows/Show S2/Show S1E05.mkv')).toEqual({ kind: 'episode', show: 'Show', season: 1, number: 5 });
    });
  });

  describe('"S5 - 01" season pair in the file name', () => {
    const danmachi = (number: string) =>
      `shows/danmachi/[EMBER] Dungeon ni Deai wo Motomeru no wa Machigatteiru Darou ka S5 - ${number}.mkv`;

    it.each([
      ['01', 1],
      ['03', 3],
    ])('reads S5 - %s as season 5 episode %s from the real DanMachi names', (tag, number) => {
      expect(parsePath(danmachi(tag))).toEqual({ kind: 'episode', show: 'danmachi', season: 5, number });
    });

    it('accepts a zero-padded season token', () => {
      expect(parsePath('shows/Show/Show S05 - 03.mkv')).toEqual({ kind: 'episode', show: 'Show', season: 5, number: 3 });
    });

    it.each([
      ['shows/[SubsPlease] Sousou no Frieren (01-28) (1080p) [Batch]/[SubsPlease] Sousou no Frieren - 09v2 (1080p) [X].mkv', null, 9],
      ['shows/[SubsPlease] Sousou no Frieren S2 (01-10) (1080p) [Batch]/[SubsPlease] Sousou no Frieren - 01 (1080p) [X].mkv', 2, 1],
    ])('keeps the absolute/season-dir result for %s', (path, season, number) => {
      expect(parsePath(path)).toEqual({ kind: 'episode', show: 'Sousou no Frieren', season, number });
    });
  });
});

describe('parsePath: films', () => {
  it.each([
    ['films/Inception (2010).mkv', 'Inception', 2010],
    ['films/Inception.2010.1080p/Inception.2010.1080p.BluRay.x264.mkv', 'Inception', 2010],
    ['films/Blade Runner 2049 (2017).mkv', 'Blade Runner 2049', 2017],
    ['films/Heat [1995] 720p.mkv', 'Heat', 1995],
  ])('%s', (path, title, year) => {
    expect(parsePath(path)).toEqual({ kind: 'movie', title, year });
  });

  it('keeps the title without a year', () => {
    expect(parsePath('films/Some Film 1080p BluRay.mkv')).toEqual({ kind: 'movie', title: 'Some Film', year: null });
  });
});

describe('parsePath: unparsed', () => {
  it('rejects paths outside shows/ and films/', () => {
    expect(parsePath('other/x.mkv')).toEqual({ kind: 'unparsed' });
  });
  it('rejects show files without an episode marker', () => {
    expect(parsePath('shows/Show/Show.mkv')).toEqual({ kind: 'unparsed' });
  });
});
