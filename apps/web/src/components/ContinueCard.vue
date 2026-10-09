<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { imageUrl } from '../api.ts';
import { popoverPosition } from '../popover.ts';
import { episodeLabel, progressPct, remainingLabel } from '../library.ts';
import type { ContinueItem } from '../types.ts';
import Icon from './Icon.vue';

const props = defineProps<{ item: ContinueItem }>();
const emit = defineEmits<{ remove: [titleId: number] }>();

const open = ref(false);
const dotsBtn = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });

// The menu lives in <body>: inside the row's scroller it would be clipped and force a horizontal scroll.
function place() {
  const a = dotsBtn.value?.getBoundingClientRect();
  const m = menuEl.value;
  if (a && m) pos.value = popoverPosition(a, { width: m.offsetWidth, height: m.offsetHeight }, { width: innerWidth, height: innerHeight });
}
const close = () => (open.value = false);
const onDown = (e: Event) => {
  const t = e.target as Node;
  if (!menuEl.value?.contains(t) && !dotsBtn.value?.contains(t)) close();
};
const onKey = (e: Event) => {
  if ((e as KeyboardEvent).key !== 'Escape') return;
  close();
  dotsBtn.value?.focus();
};
function listen(on: boolean) {
  const act = on ? 'addEventListener' : 'removeEventListener';
  document[act]('pointerdown', onDown);
  document[act]('keydown', onKey);
  window[act]('resize', close);
  window[act]('scroll', close, true);
}
watch(open, async (on) => {
  listen(on);
  if (on) {
    await nextTick();
    place();
    menuEl.value?.querySelector<HTMLElement>('button, a')?.focus();
  }
});
onBeforeUnmount(() => listen(false));
const itemTo = computed(() => ({ path: `/title/${props.item.title.id}`, query: props.item.episodeId ? { episode: props.item.episodeId } : {} }));

const to = computed(() => ({ path: `/watch/${props.item.mediaFileId}`, query: { title: props.item.title.id } }));
const label = computed(() => episodeLabel(props.item.season, props.item.episode, props.item.episodeName));
const left = computed(() => remainingLabel(props.item.positionS, props.item.durationS));
const pct = computed(() => progressPct(props.item.positionS, props.item.durationS));
const image = computed(() => props.item.stillPath ?? props.item.title.backdropPath ?? props.item.title.posterPath);
</script>

<template>
  <article class="cc">
    <RouterLink :to="to" class="thumb" :aria-label="`Continuar ${item.title.title}`">
      <img v-if="image" :src="imageUrl(image)" alt="" loading="lazy" draggable="false" />
      <span v-if="left" class="left">{{ left }}</span>
      <span class="play"><Icon name="play" :size="30" /></span>
      <span class="bar"><i :style="{ width: `${pct}%` }" /></span>
    </RouterLink>
    <div class="info">
      <div class="text">
        <p class="series">{{ item.title.title }}</p>
        <p v-if="label" class="ep" :title="label">{{ label }}</p>
      </div>
      <button
        ref="dotsBtn"
        class="dots"
        aria-label="Más opciones"
        aria-haspopup="menu"
        :aria-expanded="open"
        @click="open = !open"
      >
        <Icon name="dots" />
      </button>
    </div>
    <Teleport to="body">
      <ul v-if="open" ref="menuEl" class="cc-menu" role="menu" :style="{ left: `${pos.left}px`, top: `${pos.top}px` }">
        <li role="none"><button role="menuitem" @click="close(); emit('remove', item.title.id)">Quitar de Continuar viendo</button></li>
        <li role="none">
          <RouterLink role="menuitem" :to="itemTo" @click="close">{{ item.episodeId ? 'Ir al episodio' : 'Ir al título' }}</RouterLink>
        </li>
      </ul>
    </Teleport>
  </article>
</template>

<style scoped>
.cc { position: relative; width: var(--cc-w, 100%); }
.thumb {
  position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 12px;
  background: linear-gradient(160deg, var(--bg-hover), var(--bg-card)); transition: transform 0.2s;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.left {
  position: absolute; left: 8px; bottom: 14px; padding: 3px 9px; border-radius: 6px;
  background: rgba(8, 8, 12, 0.82); color: #fff; font-size: 0.78rem; font-weight: 600;
}
.play {
  position: absolute; inset: 0; display: grid; place-items: center; color: #fff;
  background: rgba(8, 8, 12, 0.45); opacity: 0; transition: opacity 0.15s;
}
.play :deep(svg) { padding: 12px; box-sizing: content-box; border-radius: 50%; border: 2px solid #fff; }
.thumb:hover .play, .thumb:focus-visible .play { opacity: 1; }
.thumb:hover { transform: scale(1.03); }
.bar { position: absolute; inset: auto 0 0; height: 5px; background: rgba(255, 255, 255, 0.25); }
.bar i { display: block; height: 100%; background: var(--accent); }
.info { position: relative; display: flex; align-items: flex-start; gap: 4px; padding-top: 10px; }
.text { flex: 1; min-width: 0; }
.series {
  margin: 0; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ep { margin: 2px 0 0; font-size: 0.95rem; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dots {
  flex: none; display: grid; place-items: center; width: 36px; height: 36px; min-height: 0; padding: 0;
  border-radius: 50%; background: none; color: var(--text-dim);
}
.dots:hover { background: var(--bg-hover); color: var(--text); }
.cc-menu {
  position: fixed; z-index: 60; margin: 0; padding: 6px; list-style: none; min-width: 230px;
  background: var(--bg-raised); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
}
.cc-menu button, .cc-menu a {
  display: block; width: 100%; min-height: 0; padding: 11px 14px; border-radius: 8px; background: none;
  text-align: left; font-size: 0.92rem; color: var(--text);
}
.cc-menu button:hover, .cc-menu a:hover, .cc-menu button:focus-visible, .cc-menu a:focus-visible { background: var(--bg-hover); }
</style>
