<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { imageUrl } from '../api.ts';
import type { FileStatus } from '../fileStatus.ts';
import { fileLanguages } from '../languages.ts';
import { remainingLabel } from '../library.ts';
import { isBackKey } from '../spatial.ts';
import { ACTION_LABEL, airDateLabel, episodeAction, isPlayable, runtimeLabel, type EpisodeRow } from '../titlePage.ts';
import Icon from './Icon.vue';
import LangLine from './LangLine.vue';

const props = defineProps<{ row: EpisodeRow; status: FileStatus | null; titleId: number; fallback: string | null }>();
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLElement | null>(null);
const image = computed(() => props.row.stillPath ?? props.fallback);
const action = computed(() => episodeAction(props.row));
const label = computed(() => (action.value === 'resume' ? `Continuar` : ACTION_LABEL[action.value]));
const left = computed(() => (action.value === 'resume' && props.row.progress ? remainingLabel(props.row.progress.positionS, props.row.progress.durationS) : null));
const to = computed(() => (isPlayable(props.row.file) ? { path: `/watch/${props.row.file.id}`, query: { title: props.titleId } } : null));
const meta = computed(() => [airDateLabel(props.row.airDate), runtimeLabel(props.row.runtimeMin, props.row.file?.durationS ?? null)].filter(Boolean));
const langs = computed(() => (props.row.file ? fileLanguages(props.row.file) : { audio: [], subs: [] }));

function onKey(e: KeyboardEvent) {
  if (isBackKey(e)) {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'Tab' && dialog.value) {
    const f = [...dialog.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  }
}
onMounted(async () => {
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  await nextTick();
  (dialog.value?.querySelector<HTMLElement>('[data-primary]') ?? dialog.value)?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <div class="scrim" @pointerdown.self="emit('close')">
      <div ref="dialog" class="panel" role="dialog" aria-modal="true" aria-labelledby="ep-title" tabindex="-1">
        <div class="still">
          <img v-if="image" :src="imageUrl(image)" alt="" draggable="false" />
          <button class="round x" aria-label="Cerrar" @click="emit('close')"><Icon name="close" :size="20" /></button>
        </div>
        <div class="body">
          <p class="num">T{{ row.season }} · E{{ row.number }}</p>
          <h2 id="ep-title">{{ row.name || `Episodio ${row.number}` }}</h2>
          <p v-if="meta.length" class="meta">
            <span v-for="m in meta" :key="String(m)">{{ m }}</span>
          </p>
          <p class="synopsis">{{ row.overview || 'Este episodio todavía no tiene sinopsis.' }}</p>
          <LangLine :langs="langs" />
          <p class="st">
            <span v-if="status" class="badge" :class="status.kind">{{ status.label }}</span>
            <span v-if="!row.file" class="badge queued">sin archivo</span>
            <span v-if="row.progress?.completed" class="badge seen">Visto</span>
            <span v-else-if="left" class="muted">{{ left }}</span>
          </p>
          <div class="btns">
            <RouterLink v-if="to" data-primary class="pill primary" :to="to"><Icon name="play" /> {{ label }}</RouterLink>
            <button v-else class="pill" disabled>{{ row.file ? 'Descargando' : 'Sin archivo' }}</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 16px;
  background: rgba(4, 4, 8, 0.72); backdrop-filter: blur(4px); animation: fade 0.16s ease;
}
.panel {
  display: flex; flex-direction: column; width: min(760px, 100%); max-height: 90vh; overflow: hidden; border-radius: 18px; outline: 0;
  background: var(--bg-raised); color: var(--text); box-shadow: var(--shadow); animation: rise 0.2s ease;
}
.still { position: relative; flex: none; aspect-ratio: 16 / 9; max-height: 36vh; background: linear-gradient(160deg, var(--bg-hover), var(--bg-card)); }
.still img { width: 100%; height: 100%; object-fit: cover; }
.still::after { content: ''; position: absolute; inset: 0; background: linear-gradient(transparent 55%, var(--bg-raised)); pointer-events: none; }
.x { position: absolute; z-index: 1; top: 12px; right: 12px; }
.body { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; padding: 0 clamp(18px, 4vw, 34px) clamp(20px, 4vw, 32px); margin-top: -34px; position: relative; z-index: 1; }
.body > * { flex: none; }
.num { margin: 0; font-weight: 700; color: var(--accent); }
h2 { margin: 0; font-size: clamp(1.4rem, 3vw, 1.9rem); line-height: 1.15; letter-spacing: -0.01em; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; color: var(--text-dim); font-size: 0.92rem; }
.synopsis { margin: 4px 0; max-width: 62ch; line-height: 1.6; }
.st { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; font-size: 0.9rem; }
.btns { display: flex; gap: 16px; margin-top: 8px; }
.badge { display: inline-flex; align-items: center; min-height: 0; height: 1.7em; padding: 0 0.85em; white-space: nowrap; line-height: 1; border-radius: 999px; font-size: 0.78rem; font-weight: 600; background: var(--bg-hover); color: var(--text-dim); }
.badge.ready { color: #4cc38a; }
.badge.processing, .badge.downloading { color: #e8b84a; }
.badge.error { color: var(--danger); }
.badge.seen { background: var(--accent); color: var(--accent-ink); }
@keyframes fade { from { opacity: 0; } }
@keyframes rise { from { opacity: 0; transform: translateY(14px); } }
@media (max-width: 720px) {
  .scrim { align-items: end; padding: 0; }
  .panel { max-height: 92vh; border-radius: 18px 18px 0 0; }
}
</style>
