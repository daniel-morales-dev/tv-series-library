import type { Job, Profile, TitleDetail, TitleSummary } from './types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  profiles: () => request<Profile[]>('/profiles'),
  createProfile: (name: string) =>
    request<Profile>('/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
  titles: () => request<TitleSummary[]>('/titles?limit=200'),
  title: (id: number, profileId: number) => request<TitleDetail>(`/titles/${id}?profileId=${profileId}`),
  jobs: () => request<Job[]>('/jobs'),
  play: (mediaFileId: number) => request<{ status: 'ready' | 'processing' }>(`/media-files/${mediaFileId}/play`, { method: 'POST' }),
};

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
