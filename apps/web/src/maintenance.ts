/** T81: the maintenance actions and the one-line Spanish summaries their counters turn into. */

export interface ReanalyzeSummary {
  scanned: number;
  reparsed: number;
  replaced: number;
  missing: number;
  promoted: number;
  placed: number;
  pending: number;
  reseasoned: number;
}

export interface SubtitleRepairResult {
  checked: number;
  fixed: number;
}

const plural = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`;

/** `104 revisados · 38 recolocados · 1 temporada reorganizada`; zeros are left out. */
export function reanalyzeSummary(s: ReanalyzeSummary): string {
  const parts: (string | false)[] = [
    s.scanned > 0 && plural(s.scanned, 'revisado', 'revisados'),
    s.placed > 0 && plural(s.placed, 'recolocado', 'recolocados'),
    s.reseasoned > 0 && plural(s.reseasoned, 'temporada reorganizada', 'temporadas reorganizadas'),
    s.reparsed > 0 && plural(s.reparsed, 'carpeta reasignada', 'carpetas reasignadas'),
    s.replaced > 0 && plural(s.replaced, 'reemplazado', 'reemplazados'),
    s.promoted > 0 && plural(s.promoted, 'descarga completada', 'descargas completadas'),
    s.missing > 0 && `${s.missing} ya no ${s.missing === 1 ? 'está' : 'están'} en disco`,
    s.pending > 0 && plural(s.pending, 'pendiente', 'pendientes'),
  ];
  const text = parts.filter((p): p is string => typeof p === 'string').join(' · ');
  return text || 'Sin cambios.';
}

export function subtitleSummary(r: SubtitleRepairResult): string {
  if (r.checked === 0) return 'No había subtítulos que revisar.';
  const checked = plural(r.checked, 'revisado', 'revisados');
  return r.fixed > 0 ? `${checked} · ${plural(r.fixed, 'reparado', 'reparados')}` : `${checked} · sin cambios`;
}
