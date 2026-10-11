<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { imageUrl } from '../api.ts';
import type { FileStatus } from '../fileStatus.ts';
import { KIND_LABEL, unavailableNotice } from '../library.ts';
import { playTitle } from '../play.ts';
import { myList, toggleMyList } from '../session.ts';
import type { TitleSummary } from '../types.ts';
import Icon from './Icon.vue';

const props = defineProps<{ title: TitleSummary; status?: FileStatus | null }>();
const router = useRouter();
const listed = computed(() => myList.value.some((t) => t.id === props.title.id));
const meta = computed(() => [KIND_LABEL[props.title.kind], props.title.year].filter(Boolean).join('  ·  '));
const unavailable = computed(() => unavailableNotice(props.title.available));
</script>

<template>
  <article class="card">
    <RouterLink :to="`/title/${title.id}`" draggable="false" class="cover" :aria-label="title.title">
      <img v-if="title.posterPath" :src="imageUrl(title.posterPath)" :alt="title.title" loading="lazy" draggable="false" />
      <span v-else class="fallback">{{ title.title }}</span>
      <span v-if="title.comingSoon" class="soon tag">Próximamente</span>
      <span v-if="unavailable" class="off-tag" :title="unavailable.hint">{{ unavailable.label }}</span>
    </RouterLink>
    <span v-if="status" class="badge" :class="status.kind" :title="status.detail">{{ status.label }}</span>
    <div class="over">
      <p class="name">{{ title.title }}</p>
      <p class="meta">{{ meta }}</p>
      <p v-if="unavailable" class="off-note">{{ unavailable.hint }}</p>
      <div class="acts" data-spatial-skip>
        <button v-if="!title.comingSoon && !unavailable" class="round fill" aria-label="Reproducir" @click="playTitle(router, title.id)"><Icon name="play" /></button>
        <button
          class="round"
          :class="{ on: listed }"
          :aria-label="listed ? 'Quitar de Mi lista' : 'Agregar a Mi lista'"
          :aria-pressed="listed"
          @click="toggleMyList(title)"
        >
          <Icon :name="listed ? 'check' : 'plus'" />
        </button>
        <RouterLink class="round" :to="`/title/${title.id}`" aria-label="Más info"><Icon name="info" /></RouterLink>
      </div>
    </div>
  </article>
</template>

<style scoped>
.card {
  position: relative; width: var(--card-w, 100%); aspect-ratio: 2 / 3; border-radius: 12px;
  background: var(--bg-card); transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.cover { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.tag { position: absolute; left: 8px; top: 8px; }
.off-tag {
  position: absolute; left: 8px; bottom: 8px; display: inline-flex; align-items: center; height: 1.7em; padding: 0 0.85em;
  white-space: nowrap; line-height: 1; border-radius: 999px; font-size: 0.75rem; font-weight: 600;
  background: rgba(8, 8, 12, 0.85); color: #ff9b9b;
}
.badge {
  position: absolute; right: 8px; top: 8px; display: inline-flex; align-items: center; height: 1.7em; padding: 0 0.85em;
  white-space: nowrap; line-height: 1; border-radius: 999px; font-size: 0.75rem; font-weight: 600;
  background: rgba(8, 8, 12, 0.85); color: #fff;
}
.badge.ready { color: #4cc38a; }
.badge.processing, .badge.downloading { color: #e8b84a; }
.badge.error { color: #ff9b9b; }
.fallback {
  display: grid; place-items: center; height: 100%; padding: 12px; text-align: center; font-weight: 700;
  background: linear-gradient(160deg, var(--bg-hover), var(--bg-card));
}
.over {
  position: absolute; inset: auto 0 0; padding: 40px 12px 12px; border-radius: 0 0 12px 12px;
  background: linear-gradient(transparent, rgba(8, 8, 12, 0.94) 55%); color: #fff;
  opacity: 0; transition: opacity 0.18s; pointer-events: none;
}
.name { margin: 0; font-weight: 700; font-size: 0.95rem; line-height: 1.25; }
.meta { margin: 2px 0 10px; font-size: 0.78rem; color: #c9c9d6; }
.off-note { margin: 0 0 8px; font-size: 0.78rem; color: #ff9b9b; }
.acts { display: flex; gap: 8px; pointer-events: auto; }
.acts .round { width: 38px; height: 38px; }
.card:hover, .card:focus-within { transform: scale(1.07); z-index: 4; box-shadow: var(--shadow); }
.card:hover .over, .card:focus-within .over { opacity: 1; }
.card:has(.cover:focus-visible) { outline: 3px solid var(--focus); outline-offset: 3px; }
/* Touch: no hover bar; tapping the cover opens the title, whose page holds play and list actions. */
@media (hover: none) {
  .over { display: none; }
  .card:hover, .card:focus-within { transform: none; box-shadow: none; }
}
</style>
