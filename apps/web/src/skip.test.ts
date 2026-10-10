import { describe, expect, it } from 'vitest';
import { activeSkip, classifyChapter, skipLabel } from './skip.ts';

describe('classifyChapter', () => {
  it.each([
    ['Opening', 'opening'], ['OP', 'opening'], ['OP1', 'opening'], ['Intro', 'opening'], ['Opening Theme', 'opening'], ['Title Sequence', 'opening'],
    ['Ending', 'ending'], ['ED', 'ending'], ['ED2', 'ending'], ['Credits', 'ending'], ['Créditos', 'ending'], ['Outro', 'ending'], ['Preview', 'ending'], ['Avance', 'ending'],
    ['Recap', 'recap'], ['Previously', 'recap'], ['Resumen', 'recap'], ['Anteriormente', 'recap'], ['Previously on', 'recap'],
    ['Part A', 'other'], ['Episode', 'other'], ['Opera scene', 'other'], ['Dedication', 'other'], ['', 'other'],
  ])('%s -> %s', (title, kind) => expect(classifyChapter(title)).toBe(kind));
  it('treats a missing title as other', () => expect(classifyChapter(null)).toBe('other'));
});

describe('activeSkip', () => {
  const chapters = [
    { startS: 0, endS: 60, title: 'Recap' },
    { startS: 60, endS: 150, title: 'OP' },
    { startS: 150, endS: 1300, title: 'Part A' },
    { startS: 1300, endS: 1400, title: 'ED' },
  ];
  it('returns the skippable chapter containing the time, with its end', () => {
    expect(activeSkip(chapters, 10)).toEqual({ kind: 'recap', endS: 60 });
    expect(activeSkip(chapters, 60)).toEqual({ kind: 'opening', endS: 150 });
    expect(activeSkip(chapters, 1399.9)).toEqual({ kind: 'ending', endS: 1400 });
  });
  it('returns null outside skippable ranges, at a range end and with no chapters', () => {
    expect(activeSkip(chapters, 150)).toBeNull();
    expect(activeSkip(chapters, 700)).toBeNull();
    expect(activeSkip(chapters, 1400)).toBeNull();
    expect(activeSkip([], 5)).toBeNull();
    expect(activeSkip(undefined, 5)).toBeNull();
  });
  it('labels the button in Spanish', () => {
    expect(skipLabel('opening')).toBe('Saltar opening');
    expect(skipLabel('ending')).toBe('Saltar ending');
    expect(skipLabel('recap')).toBe('Saltar resumen');
  });
});
