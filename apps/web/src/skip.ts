export type SkipKind = 'opening' | 'ending' | 'recap' | 'intro';
export interface Chapter {
  startS: number;
  endS: number;
  title: string | null;
}

// Keywords in EN, JP-romaji fansub style (OP/ED) and ES, matched on accent-stripped lowercase words.
// "preview" (next-episode teaser) is grouped with the ending: it always follows the credits.
// T79: the intro is its own kind — it ends where the OP starts, so each needs its own skip target.
const RULES: [SkipKind, RegExp][] = [
  ['recap', /\b(recap|previously|resumen|anteriormente)\b/],
  ['intro', /\bintro\b/],
  ['opening', /\b(op\d*|opening|title sequence|apertura)\b/],
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

const LABELS: Record<SkipKind, string> = { intro: 'Saltar intro', opening: 'Saltar opening', ending: 'Saltar ending', recap: 'Saltar resumen' };
export const skipLabel = (kind: SkipKind) => LABELS[kind];
