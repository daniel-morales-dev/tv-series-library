export type TitleKind = 'movie' | 'series' | 'anime';

export interface FranchiseItem {
  id: number;
  name: string;
  posterPath: string | null;
  kind: TitleKind;
  year: number | null;
  order: number;
  current: boolean;
}

export interface Franchise {
  id: number;
  name: string;
  items: FranchiseItem[];
}

export type FranchiseRelation = 'Precuela' | 'Actual' | 'Secuela';

export interface FranchiseEntry extends FranchiseItem {
  relation: FranchiseRelation;
  typeLabel: 'Película' | 'Serie';
}

// Ordered strip entries labelled relative to the title being viewed.
export function franchiseEntries(items: FranchiseItem[]): FranchiseEntry[] {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const currentOrder = sorted.find((i) => i.current)?.order;
  return sorted.map((i) => ({
    ...i,
    relation: i.current ? 'Actual' : currentOrder === undefined || i.order > currentOrder ? 'Secuela' : 'Precuela',
    typeLabel: i.kind === 'movie' ? 'Película' : 'Serie',
  }));
}
