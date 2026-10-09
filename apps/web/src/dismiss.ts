import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/** Calls `close` on a pointer press outside `root` or on Escape. */
export function useDismiss(root: Ref<HTMLElement | null>, close: () => void): void {
  const down = (e: Event) => {
    if (root.value && !root.value.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
  onMounted(() => {
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', down);
    document.removeEventListener('keydown', key);
  });
}
