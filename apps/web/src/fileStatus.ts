import type { Job, MediaFile } from './types.ts';

export interface FileStatus {
  kind: 'ready' | 'downloading' | 'processing' | 'queued' | 'error';
  label: string;
  detail?: string;
}

export function fileStatus(file: MediaFile, jobs: Job[]): FileStatus {
  if (file.status === 'ready') return { kind: 'ready', label: 'listo' };
  if (file.status === 'downloading') return { kind: 'downloading', label: 'descargando' };
  // Jobs arrive active-first, so the first match is the current one.
  const job = jobs.find((j) => j.mediaFileId === file.id);
  if (file.status === 'error' || job?.status === 'error') return { kind: 'error', label: 'error', detail: job?.error ?? undefined };
  if (job?.status === 'running') return { kind: 'processing', label: `procesando ${Math.round(job.progress * 100)} %` };
  if (file.status === 'processing') return { kind: 'processing', label: 'procesando' };
  return { kind: 'queued', label: 'en cola' };
}

export const needsPolling = (files: MediaFile[]): boolean => files.some((f) => f.status !== 'ready');
