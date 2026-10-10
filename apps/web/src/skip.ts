export type SkipKind = 'opening' | 'ending' | 'recap';
export interface Chapter {
  startS: number;
  endS: number;
  title: string | null;
}

// Keywords in EN, JP-romaji fansub style (OP/ED) and ES, matched on accent-stripped lowercase words.
// "preview" (next-episode teaser) is grouped with the ending: it always follows the credits.
const RULES: [SkipKind, RegExp][] = [
  ['recap', /\b(recap|previously|resumen|anteriormente)\b/],
  ['opening', /\b(op\d*|opening|intro|title sequence|apertura)\b/],
  ['ending', /\b(ed\d*|ending|credit\w*|outro|preview|avance|cierre)\b/],
];

export function classifyChapter(title: string | null): SkipKind | 'other' {
  const t = (title ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return RULES.find(([, re]) => re.test(t))?.[0] ?? 'other';
}

export function activeSkip(chapters: Chapter[] | undefined, time: number): { kind: SkipKind; endS: number } | null {
  for (const c of chapters ?? []) {
    const kind = classifyChapter(c.title);
    if (kind !== 'other' && time >= c.startS && time < c.endS) return { kind, endS: c.endS };
  }
  return null;
}

export const skipLabel = (kind: SkipKind) => `Saltar ${kind === 'recap' ? 'resumen' : kind}`;
