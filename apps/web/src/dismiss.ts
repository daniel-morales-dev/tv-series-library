import { onBeforeUnmount, onMounted, type Ref } from 'vue';
import { isBackKey } from './spatial.ts';

/**
 * Calls `close` on a pointer press outside `root` or on Back/Escape. `close` returns true when it actually
 * closed something, which marks the key as consumed so it doesn't also navigate back.
 */
export function useDismiss(root: Ref<HTMLElement | null>, close: () => boolean | void): void {
  const down = (e: Event) => {
    if (root.value && !root.value.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (!isBackKey(e) || (e.key === 'Backspace' && e.target instanceof HTMLInputElement)) return;
    if (close() === true) e.preventDefault();
  };
  onMounted(() => {
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', down);
    document.removeEventListener('keydown', key);
  });
}
