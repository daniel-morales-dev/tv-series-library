import type { Router } from 'vue-router';
import { api, getProfileId } from './api.ts';
import { firstFileId } from './library.ts';

/** Starts a title from its first playable file; falls back to the title page when it has none. */
export async function playTitle(router: Router, titleId: number): Promise<void> {
  try {
    const fileId = firstFileId(await api.title(titleId, getProfileId() ?? 0));
    if (fileId) return void router.push({ path: `/watch/${fileId}`, query: { title: titleId } });
  } catch {
    // fall through to the title page
  }
  router.push(`/title/${titleId}`);
}
