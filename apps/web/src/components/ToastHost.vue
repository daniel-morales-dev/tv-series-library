<script setup lang="ts">
import { dismissToast, toast } from '../toast.ts';

function act() {
  const run = toast.value?.action?.run;
  dismissToast();
  run?.();
}
</script>

<template>
  <div class="host" role="status" aria-live="polite">
    <div v-if="toast" :key="toast.id" class="toast">
      <span>{{ toast.message }}</span>
      <button v-if="toast.action" class="undo" @click="act">{{ toast.action.label }}</button>
    </div>
  </div>
</template>

<style scoped>
.host { position: fixed; inset: auto 0 calc(20px + env(safe-area-inset-bottom)); z-index: 90; display: flex; justify-content: center; padding: 0 var(--gutter); pointer-events: none; }
.toast {
  pointer-events: auto; display: flex; align-items: center; gap: 18px; max-width: 560px; padding: 8px 8px 8px 22px;
  border-radius: 999px; background: var(--bg-raised); border: 1px solid var(--line); box-shadow: var(--shadow);
  animation: rise 0.22s ease-out;
}
.toast span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.undo {
  flex: none; min-height: 44px; padding: 0 20px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-weight: 700;
}
.undo:hover { background: var(--accent); filter: brightness(1.12); }
@keyframes rise { from { transform: translateY(12px); opacity: 0; } }
@media (max-width: 600px) { .host { bottom: calc(80px + env(safe-area-inset-bottom)); } }
</style>
