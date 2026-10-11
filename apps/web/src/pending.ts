/** T77: the `/api/pending` shape, the folder-relative path and the reason codes the server stores. */

export type PendingParsed =
  | { kind: 'movie'; title: string; year: number | null }
  | { kind: 'episode'; show: string; season: number | null; number: number }
  | { kind: 'extra'; show: string; label: string }
  | { kind: 'unparsed' };

export interface PendingCandidate {
  tmdbType: 'tv' | 'movie';
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  overview: string | null;
}

export interface PendingItem {
  id: number;
  path: string;
  size: number | null;
  parsed: PendingParsed;
  reason: string;
  candidates: PendingCandidate[];
  createdAt: string;
}

export interface ConfirmChoice {
  tmdbType: 'tv' | 'movie';
  tmdbId: number;
}

// The reason codes the server writes (ingestor's toPending and pending.ts).
const REASON_LABELS: Record<string, string> = {
  no_match: 'No se encontró la serie en TMDB',
  unmapped_episode: 'Episodio sin ubicación en las temporadas',
  unparsed: 'Nombre de archivo no reconocido',
  missing_target: 'Falta indicar la temporada o el episodio',
  group_ambiguous: 'No se pudo decidir la temporada',
  file_unreadable: 'No se pudo leer el archivo',
};

export function pendingReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? 'Motivo desconocido';
}

// The confirm endpoint answers `{ error: code }`; these are the codes it can send.
const CONFIRM_ERRORS: Record<string, string> = {
  not_found: 'Este archivo ya no está pendiente.',
  group_ambiguous: 'No se pudo decidir la temporada.',
  file_unreadable: 'No se pudo leer el archivo.',
  unmapped_episode: 'El episodio no existe en las temporadas de esa serie.',
  missing_target: 'Falta indicar la temporada o el episodio.',
  tmdb_unavailable: 'No se pudo consultar TMDB. Inténtalo de nuevo cuando haya conexión.',
  ingest_disabled: 'El servidor no tiene la ingesta activada.',
};

export function pendingErrorLabel(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  return CONFIRM_ERRORS[message] ?? (message && !/^\d+$/.test(message) ? message : 'No se pudo completar la acción.');
}

export const fileName = (path: string): string => path.split('/').at(-1) || path;

/** One line identifying what the parser saw: `T3E5 · Show`, `Película · Title`, `Extra · OP1`. */
export function parsedLabel(parsed: PendingParsed): string | null {
  if (parsed.kind === 'episode') {
    const code = parsed.season === null ? `E${parsed.number}` : `T${parsed.season}E${parsed.number}`;
    return [code, parsed.show].filter(Boolean).join(' · ');
  }
  if (parsed.kind === 'movie') return ['Película', parsed.title].filter(Boolean).join(' · ');
  if (parsed.kind === 'extra') return ['Extra', parsed.label].filter(Boolean).join(' · ');
  return null;
}

export function candidateLabel(candidate: PendingCandidate): string {
  return [candidate.title, candidate.year ? `(${candidate.year})` : null].filter(Boolean).join(' ');
}
