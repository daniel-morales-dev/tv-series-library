import { describe, expect, it } from 'vitest';
import { franchiseEntries, type FranchiseItem } from './franchise.ts';

const item = (id: number, order: number, extra: Partial<FranchiseItem> = {}): FranchiseItem => ({
  id,
  name: `T${id}`,
  posterPath: null,
  kind: 'series',
  year: 2009,
  order,
  current: false,
  ...extra,
});

describe('franchiseEntries', () => {
  it('labels items before the current one Precuela, the current Actual, the rest Secuela', () => {
    const entries = franchiseEntries([item(1, 1), item(2, 2, { current: true }), item(3, 3)]);
    expect(entries.map((e) => e.relation)).toEqual(['Precuela', 'Actual', 'Secuela']);
  });

  it('sorts by order even when the server list arrives shuffled', () => {
    const entries = franchiseEntries([item(3, 3), item(1, 1, { current: true }), item(2, 2)]);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.relation)).toEqual(['Actual', 'Secuela', 'Secuela']);
  });

  it('tags movies Película and everything else Serie', () => {
    const entries = franchiseEntries([item(1, 1, { kind: 'movie' }), item(2, 2, { kind: 'anime', current: true }), item(3, 3, { kind: 'series' })]);
    expect(entries.map((e) => e.typeLabel)).toEqual(['Película', 'Serie', 'Serie']);
  });

  it('leaves everything as Secuela if no item is current', () => {
    expect(franchiseEntries([item(1, 1), item(2, 2)]).map((e) => e.relation)).toEqual(['Secuela', 'Secuela']);
  });
});
