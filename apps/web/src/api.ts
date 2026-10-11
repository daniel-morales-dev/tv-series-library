import type { Activity } from './activity.ts';
import type { DataPlan, DataStatus } from './dataMigration.ts';
import type { AppConfig, LibraryCandidate } from './config.ts';
import type { Franchise } from './franchise.ts';
import type { DirListing } from './folderPicker.ts';
import type { NetworkInfo } from './network.ts';
import type { Chapter } from './skip.ts';
import type { ContinueItem, Job, Profile, Suggestion, TitleDetail, TitleSummary } from './types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    if (res.status === 400) {
      const body = await res.json().catch(() => null);
      if (typeof body?.error === 'string') throw new Error(body.error);
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => null);
      if (body?.error === 'downloading') throw new Error('downloading');
      if (body?.error === 'processing_disabled') throw new Error('processing_disabled');
    }
    throw new Error(`${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// T47e: the server answers 409/400 with a Spanish `message` that the panel shows as is.
async function migrationRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/data-migration${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.message === 'string' ? body.message : `${res.status}`);
  }
  return res.json();
}

const JSON_HEADERS = { 'content-type': 'application/json' };

// T52: the refresh endpoint answers errors with a Spanish `message` that the title page shows as is.
async function metadataRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new Error('No se pudo conectar con el servidor.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.message === 'string' ? body.message : `${res.status}`);
  }
  return res.json();
}

export const api = {
  profiles: () => request<Profile[]>('/profiles'),
  createProfile: (name: string) =>
    request<Profile>('/profiles', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name }) }),
  updateProfile: (id: number, name: string) =>
    request<Profile>(`/profiles/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name }) }),
  deleteProfile: (id: number) => request<void>(`/profiles/${id}`, { method: 'DELETE' }),
  titles: (kind?: string) => request<TitleSummary[]>(`/titles?limit=200&sort=recent${kind ? `&kind=${kind}` : ''}`),
  titlesBy: (params: string) => request<TitleSummary[]>(`/titles?${params}`),
  suggest: (q: string) => request<Suggestion[]>(`/search/suggest?q=${encodeURIComponent(q)}`),
  continueWatching: (pid: number) => request<ContinueItem[]>(`/profiles/${pid}/continue-watching`),
  removeContinue: (pid: number, titleId: number) => request<void>(`/profiles/${pid}/continue-watching/${titleId}`, { method: 'DELETE' }),
  myList: (pid: number) => request<TitleSummary[]>(`/profiles/${pid}/my-list`),
  addToMyList: (pid: number, titleId: number) => request<void>(`/profiles/${pid}/my-list/${titleId}`, { method: 'PUT' }),
  removeFromMyList: (pid: number, titleId: number) => request<void>(`/profiles/${pid}/my-list/${titleId}`, { method: 'DELETE' }),
  title: (id: number, profileId: number) => request<TitleDetail & { franchise: Franchise | null }>(`/titles/${id}?profileId=${profileId}`),
  linkFranchise: (titleId: number, ofTitleId: number, relation?: 'sequel' | 'prequel') =>
    request<{ franchiseId: number }>(`/titles/${titleId}/franchise`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ofTitleId, relation }) }),
  unlinkFranchise: (titleId: number) => request<void>(`/titles/${titleId}/franchise`, { method: 'DELETE' }),
  setFinished: (pid: number, titleId: number, finished: boolean) =>
    request<void>(`/profiles/${pid}/titles/${titleId}/finished`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ finished }) }),
  setSeasonFinished: (pid: number, titleId: number, season: number, finished: boolean) =>
    request<void>(`/profiles/${pid}/titles/${titleId}/seasons/${season}/finished`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ finished }) }),
  setFileFinished: (pid: number, mediaFileId: number, finished: boolean) =>
    request<void>(`/profiles/${pid}/media-files/${mediaFileId}/finished`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ finished }) }),
  config: () => request<AppConfig>('/config'),
  configCandidates: () => request<{ candidates: LibraryCandidate[] }>('/config/candidates'),
  dirs: (path?: string) => request<DirListing>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  network: () => request<NetworkInfo>('/network'),
  setContentDir: (path: string, create = false) =>
    request<AppConfig>('/config/content-dir', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ path, create }) }),
  chapters: (mediaFileId: number) => request<{ chapters: Chapter[] }>(`/media-files/${mediaFileId}/chapters`),
  refreshMetadata: (titleId: number) => metadataRequest<{ ok: true }>(`/titles/${titleId}/refresh-metadata`, { method: 'POST' }),
  dataPlan: () => migrationRequest<DataPlan>('/plan'),
  dataStatus: () => migrationRequest<DataStatus>('/status'),
  startDataMove: () => migrationRequest<DataStatus>('/start', { method: 'POST', headers: JSON_HEADERS, body: '{}' }),
  freeDataOrigin: () =>
    migrationRequest<{ freedPackages: number; freedBytes: number; kept: string[] }>('/confirm-free-origin', { method: 'POST' }),
  jobs: () => request<Job[]>('/jobs'),
  activity: () => request<Activity>('/activity'),
  pauseProcessing: () => request<{ paused: boolean }>('/processing/pause', { method: 'POST' }),
  resumeProcessing: () => request<{ paused: boolean }>('/processing/resume', { method: 'POST' }),
  retryFile: (mediaFileId: number) => request<{ jobId: number }>(`/media-files/${mediaFileId}/process`, { method: 'POST' }),
  play: (mediaFileId: number) => request<{ status: 'ready' | 'processing' }>(`/media-files/${mediaFileId}/play`, { method: 'POST' }),
  random: (pid?: number | null) => request<{ titleId: number; mediaFileId: number }>(`/random${pid ? `?profile=${pid}` : ''}`),
};

export function playErrorMessage(e: unknown): string {
  if (!(e instanceof Error) || e.message === '404') return 'No se pudo cargar el video.';
  return e.message === 'downloading' ? 'Este episodio aún se está descargando.' : `No se pudo preparar el video (${e.message}).`;
}

export function saveProgress(profileId: number, mediaFileId: number, positionS: number, durationS: number): void {
  fetch(`/api/profiles/${profileId}/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaFileId, positionS, durationS }),
    keepalive: true,
  }).catch(() => {});
}

export const streamUrl = (mediaFileId: number, path = 'master.m3u8') => `/api/stream/${mediaFileId}/${path}`;

export const imageUrl = (path: string) => `/api/images/${path}`;

const KEY = 'profileId';
export function getProfileId(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function setProfileId(id: number): void {
  try {
    localStorage.setItem(KEY, String(id));
  } catch {
    // storage blocked: the choice just won't persist
  }
}
export function clearProfileId(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage blocked: nothing to clear
  }
}
