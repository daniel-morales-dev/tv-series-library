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

  it('derives the show from the file name when it sits directly under shows/', () => {
    expect(parsePath('shows/Some.Show.S01E02.mkv')).toEqual({ kind: 'episode', show: 'Some Show', season: 1, number: 2 });
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
