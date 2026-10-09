import { ref } from 'vue';
import { api, getProfileId, setProfileId } from './api.ts';
import { loadTheme } from './theme.ts';
import type { Profile, TitleSummary } from './types.ts';
import { toggleInList } from './library.ts';

export const currentProfile = ref<Profile | null>(null);
export const myList = ref<TitleSummary[]>([]);
/** Pages with a full-bleed hero set this so the header can stay transparent over it. */
export const hasHero = ref(false);

export function selectProfile(p: Profile): void {
  setProfileId(p.id);
  currentProfile.value = p;
  myList.value = [];
  loadTheme(p.id);
}

export async function ensureProfile(): Promise<void> {
  const id = getProfileId();
  if (!id || currentProfile.value?.id === id) return;
  try {
    const found = (await api.profiles()).find((p) => p.id === id);
    if (found) currentProfile.value = found;
  } catch {
    // header just shows a neutral avatar until the server answers
  }
}

export async function loadMyList(): Promise<void> {
  const id = getProfileId();
  if (id) myList.value = await api.myList(id);
}

export const inMyList = (titleId: number) => myList.value.some((t) => t.id === titleId);

/** Optimistic: flips locally, rolls back if the server refuses. */
export async function toggleMyList(title: TitleSummary): Promise<void> {
  const pid = getProfileId();
  if (!pid) return;
  const before = myList.value;
  const { list, added } = toggleInList(before, title);
  myList.value = list;
  try {
    await (added ? api.addToMyList(pid, title.id) : api.removeFromMyList(pid, title.id));
  } catch {
    myList.value = before;
  }
}
