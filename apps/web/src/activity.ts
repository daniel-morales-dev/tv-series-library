export interface ActivityItem {
  mediaFileId: number;
  jobId: number | null;
  status: 'running' | 'queued' | 'error';
  /** 0..1, exactly as stored by the server (MAIN_RUN_SHARE already applied there). */
  progress: number;
  error: string | null;
  kind: 'episode' | 'film' | 'extra';
  title: string;
  extraLabel: string | null;
  season: number | null;
  episode: number | null;
  episodeName: string | null;
}

export interface Activity {
  running: ActivityItem[];
  /** Preview window only; `queuedTotal` is the real number of queued jobs. */
  queued: ActivityItem[];
  queuedTotal: number;
  failed: ActivityItem[];
}

/** Badge number: everything running plus everything waiting, not just the preview. */
export function activityCount(activity: Activity | null): number {
  return activity ? activity.running.length + activity.queuedTotal : 0;
}

/** Dim context under the title: `T1E3 · Name`, `Extra · OP1`, or nothing for a film. */
export function itemContext(item: ActivityItem): string | null {
  if (item.kind === 'extra') return item.extraLabel ? `Extra · ${item.extraLabel}` : 'Extra';
  if (item.kind === 'film') return null;
  const code = item.season !== null && item.episode !== null ? `T${item.season}E${item.episode}` : null;
  const name = item.episodeName?.trim() || null;
  return [code, name].filter(Boolean).join(' · ') || 'Episodio';
}
