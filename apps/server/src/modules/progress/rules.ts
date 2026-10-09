export const COMPLETION_THRESHOLD = 0.9;

export function isCompleted(positionS: number, durationS: number): boolean {
  return durationS > 0 && positionS / durationS >= COMPLETION_THRESHOLD;
}

export interface PlayableFile {
  mediaFileId: number;
  completed: boolean;
  positionS: number;
}

export interface LatestProgress {
  mediaFileId: number;
  positionS: number;
  completed: boolean;
}

export interface ContinueTarget {
  mediaFileId: number;
  positionS: number;
}

/**
 * `ordered` holds the title's playable (ready, non-extra) files in watch order.
 * A completed latest file that is not in the list (an extra) restarts the search from the top.
 */
export function resolveContinueTarget(latest: LatestProgress, ordered: PlayableFile[]): ContinueTarget | null {
  if (!latest.completed) return { mediaFileId: latest.mediaFileId, positionS: latest.positionS };
  const from = ordered.findIndex((f) => f.mediaFileId === latest.mediaFileId) + 1;
  const next = ordered.slice(from).find((f) => !f.completed);
  return next ? { mediaFileId: next.mediaFileId, positionS: next.positionS } : null;
}
