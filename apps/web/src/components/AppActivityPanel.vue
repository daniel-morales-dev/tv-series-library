<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { budgetLine, itemContext, processingControl, type Activity } from '../activity.ts';
import { useDismiss } from '../dismiss.ts';
import Icon from './Icon.vue';

const props = defineProps<{ open: boolean; activity: Activity | null; error: boolean; retrying: number[]; disabled: boolean }>();
const emit = defineEmits<{ close: []; retry: [mediaFileId: number]; processing: [action: 'pause' | 'resume'] }>();

const root = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
let opener: HTMLElement | null = null;

useDismiss(root, () => {
  if (!props.open) return false;
  emit('close');
  return true;
});

watch(
  () => props.open,
  (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      closeBtn.value?.focus();
      return;
    }
    // Only steal focus back when it is still ours (Escape, backdrop); a click elsewhere keeps its own focus.
    if (root.value?.contains(document.activeElement)) opener?.focus();
    opener = null;
  },
  { flush: 'post' },
);

const pct = (p: number) => `${Math.round(p * 100)} %`;
const more = computed(() => {
  const a = props.activity;
  return a ? Math.max(0, a.queuedTotal - a.queued.length) : 0;
});
const control = computed(() => (props.activity ? processingControl(props.activity.paused, props.disabled) : null));
const budget = computed(() => budgetLine(props.activity?.budget ?? null));
</script>

<template>
  <Teleport to="body">
    <Transition name="veil">
      <div v-if="open" class="veil" />
    </Transition>
    <Transition name="drawer">
      <aside v-if="open" ref="root" class="panel" role="dialog" aria-modal="true" aria-labelledby="activity-title">
        <header class="head">
          <h2 id="activity-title">Actividad</h2>
          <button ref="closeBtn" class="x" aria-label="Cerrar" @click="emit('close')">
            <Icon name="close" :size="20" />
          </button>
        </header>

        <div v-if="control" class="control">
          <span v-if="control.kind === 'resume'" class="tag" role="status">{{ control.chip }}</span>
          <button v-if="control.kind !== 'disabled'" class="toggle" @click="emit('processing', control.kind)">
            {{ control.label }}
          </button>
          <span v-if="control.kind === 'disabled'" class="off">{{ control.note }}</span>
        </div>

        <div class="body">
          <p v-if="error" class="note">No se pudo actualizar. Esto es lo último que se vio.</p>
          <p v-if="budget" class="note">Procesando {{ budget }}</p>

          <template v-if="activity">
            <p v-if="!activity.running.length && !activity.queued.length && !activity.failed.length" class="note">
              Nada en marcha. Todo al día.
            </p>

            <section v-if="activity.running.length" aria-labelledby="activity-running">
              <h3 id="activity-running">Procesando ahora</h3>
              <ul class="items">
                <li v-for="i in activity.running" :key="i.mediaFileId" class="item">
                  <span class="name">{{ i.title }}</span>
                  <span v-if="itemContext(i)" class="ctx">{{ itemContext(i) }}</span>
                  <div class="prog">
                    <span class="bar"><i :style="{ width: pct(i.progress) }" /></span>
                    <span class="pct">procesando {{ pct(i.progress) }}</span>
                  </div>
                </li>
              </ul>
            </section>

            <section v-if="activity.queued.length" aria-labelledby="activity-queued">
              <h3 id="activity-queued">En cola</h3>
              <ol class="items queue">
                <li v-for="(i, n) in activity.queued" :key="i.mediaFileId" class="item row">
                  <span class="rank" aria-hidden="true">{{ n + 1 }}</span>
                  <span class="copy">
                    <span class="name">{{ i.title }}</span>
                    <span v-if="itemContext(i)" class="ctx">{{ itemContext(i) }}</span>
                  </span>
                </li>
              </ol>
              <p v-if="more" class="note">y {{ more }} más</p>
            </section>

            <section v-if="activity.failed.length" aria-labelledby="activity-failed">
              <h3 id="activity-failed">Con error</h3>
              <ul class="items">
                <li v-for="i in activity.failed" :key="i.mediaFileId" class="item row">
                  <span class="copy">
                    <span class="name">{{ i.title }}</span>
                    <span v-if="itemContext(i)" class="ctx">{{ itemContext(i) }}</span>
                    <span v-if="i.error" class="err" :title="i.error">{{ i.error }}</span>
                  </span>
                  <button class="retry" :disabled="retrying.includes(i.mediaFileId)" @click="emit('retry', i.mediaFileId)">
                    {{ retrying.includes(i.mediaFileId) ? 'Reintentando…' : 'Reintentar' }}
                  </button>
                </li>
              </ul>
            </section>
          </template>
          <p v-else-if="!error" class="note">Cargando…</p>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 60; background: rgba(6, 6, 10, 0.52); }
.panel {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 61; display: flex; flex-direction: column;
  width: min(430px, 100vw); background: var(--bg-raised); color: var(--text);
  border-left: 1px solid var(--line); box-shadow: -14px 0 44px rgba(0, 0, 0, 0.4);
}
.veil-enter-active, .veil-leave-active { transition: opacity 0.22s ease; }
.veil-enter-from, .veil-leave-to { opacity: 0; }
.drawer-enter-active, .drawer-leave-active { transition: transform 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); }
.drawer-enter-from, .drawer-leave-to { transform: translateX(100%); }

.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 10px 10px 20px; border-bottom: 1px solid var(--line); }
.head h2 { margin: 0; font-size: 1.1rem; letter-spacing: -0.01em; }
.x { display: grid; place-items: center; min-height: 0; width: 40px; height: 40px; padding: 0; border-radius: 50%; background: none; color: var(--text-dim); }
.x:hover { background: var(--bg-hover); color: var(--text); }

.control { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 10px 20px; border-bottom: 1px solid var(--line); }
.tag { padding: 4px 10px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: 0.78rem; font-weight: 700; }
.off { font-size: 0.84rem; color: var(--text-dim); }

.body { flex: 1; overflow-y: auto; padding: 2px 20px 28px; }
section { margin-top: 20px; }
section h3 { margin: 0 0 6px; font-size: 0.8rem; font-weight: 700; color: var(--text-dim); }
.items { margin: 0; padding: 0; list-style: none; }
.item { padding: 10px 0 12px; border-bottom: 1px solid var(--line); }
.item:last-child { border-bottom: 0; }
.item.row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.copy { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.name { display: block; overflow: hidden; font-size: 0.95rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.ctx { display: block; overflow: hidden; font-size: 0.84rem; color: var(--text-dim); text-overflow: ellipsis; white-space: nowrap; }
.err {
  display: -webkit-box; margin-top: 3px; overflow: hidden; font-size: 0.8rem; color: var(--danger);
  -webkit-box-orient: vertical; -webkit-line-clamp: 2;
}

.prog { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
.bar { flex: 1; height: 4px; overflow: hidden; border-radius: 999px; background: var(--bg-hover); }
.bar i { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 0.5s ease; }
.pct { font-size: 0.78rem; color: var(--text-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }

.rank { flex: none; width: 1.5em; font-size: 0.78rem; color: var(--text-dim); text-align: right; font-variant-numeric: tabular-nums; }
.retry, .toggle {
  flex: none; min-height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--bg-card); color: var(--text); font-size: 0.84rem; font-weight: 600;
}
.retry:hover:not(:disabled), .toggle:hover:not(:disabled) { background: var(--bg-hover); }
.retry:disabled, .toggle:disabled { opacity: 0.55; cursor: default; }
.note { margin: 16px 0 0; font-size: 0.88rem; color: var(--text-dim); }

@media (prefers-reduced-motion: reduce) {
  .veil-enter-active, .veil-leave-active, .drawer-enter-active, .drawer-leave-active, .bar i { transition: none; }
}
</style>
