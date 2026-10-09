import { ref } from 'vue';

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

export const toast = ref<Toast | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

export function dismissToast(): void {
  clearTimeout(timer);
  toast.value = null;
}

/** One toast at a time; a new one replaces the old. */
export function showToast(message: string, action?: Toast['action'], ms = 5000): void {
  clearTimeout(timer);
  toast.value = { id: ++seq, message, action };
  timer = setTimeout(dismissToast, ms);
}
