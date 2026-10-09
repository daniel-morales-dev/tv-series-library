import { ref } from 'vue';

export type Theme = 'dark' | 'light';
export const theme = ref<Theme>('dark');

const key = (profileId: number) => `theme:${profileId}`;

export function loadTheme(profileId: number | null): void {
  let saved: string | null = null;
  try {
    if (profileId) saved = localStorage.getItem(key(profileId));
  } catch {
    // storage blocked: fall back to dark
  }
  theme.value = saved === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
}

export function toggleTheme(profileId: number | null): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
  try {
    if (profileId) localStorage.setItem(key(profileId), theme.value);
  } catch {
    // storage blocked: the choice just won't persist
  }
}
