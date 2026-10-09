import { titleLanguages, type Languages } from './languages.ts';
import { playPlan, buildEpisodes } from './titlePage.ts';
import type { Sort } from './browse.ts';
import type { TitleDetail, TitleSummary } from './types.ts';

const STATUS_PREFIX = { play: 'Comenzar a ver', resume: 'Continuar', rewatch: 'Ver de nuevo' } as const;

/** "Continuar: T1·E3", "Comenzar a ver: T1·E1", "Ver de nuevo: T1·E1"; movies have no episode tag. */
export function statusLine(d: TitleDetail): string {
  const plan = playPlan(d);
  if (!plan) return '';
  const row = buildEpisodes(d).flatMap((s) => s.rows).find((r) => r.file?.id === plan.fileId);
  return row ? `${STATUS_PREFIX[plan.action]}: T${row.season}·E${row.number}` : STATUS_PREFIX[plan.action];
}

const MAX_SUBS = 3;

/** One line: "Audio Japonés · Sub Inglés, Español +2". */
export function langSummary(l: Languages): string {
  const parts: string[] = [];
  if (l.audio.length) parts.push(`Audio ${l.audio.join(', ')}`);
  if (l.subs.length) {
    const extra = l.subs.length - MAX_SUBS;
    parts.push(`Sub ${l.subs.slice(0, MAX_SUBS).join(', ')}${extra > 0 ? ` +${extra}` : ''}`);
  }
  return parts.join(' · ');
}

export const detailLanguages = (d: TitleDetail): string => langSummary(titleLanguages(d.files));

/** `activity` maps titleId → ISO time of the last watch; watched titles come first, the rest keep list order. */
export function sortMyList(items: TitleSummary[], sort: Sort, activity: Record<number, string>): TitleSummary[] {
  const list = [...items];
  if (sort === 'title') return list.sort((a, b) => a.title.localeCompare(b.title, 'es'));
  if (sort === 'year') return list.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));
  // Array.prototype.sort is stable, so ties (never watched) keep the list order.
  return list.sort((a, b) => (activity[b.id] ?? '').localeCompare(activity[a.id] ?? ''));
}

export function restoreAt<T>(list: T[], item: T, index: number): T[] {
  const out = [...list];
  out.splice(Math.min(index, out.length), 0, item);
  return out;
}
