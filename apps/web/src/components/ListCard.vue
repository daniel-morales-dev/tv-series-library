<script setup lang="ts">
import { imageUrl } from '../api.ts';
import type { TitleSummary } from '../types.ts';
import Icon from './Icon.vue';

const props = defineProps<{ title: TitleSummary; status?: string; langs?: string }>();
defineEmits<{ remove: [title: TitleSummary] }>();

const art = props.title.backdropPath ?? props.title.posterPath;
</script>

<template>
  <article class="lc">
    <RouterLink :to="`/title/${title.id}`" class="thumb" draggable="false" :aria-label="title.title">
      <img v-if="art" :src="imageUrl(art)" alt="" loading="lazy" draggable="false" :class="{ poster: !title.backdropPath }" />
      <span v-else class="fallback">{{ title.title }}</span>
    </RouterLink>
    <div class="info">
      <div class="text">
        <p class="name">{{ title.title }}</p>
        <p v-if="status" class="status">{{ status }}</p>
        <p v-if="langs" class="langs" :title="langs">{{ langs }}</p>
      </div>
      <button class="del" :aria-label="`Quitar ${title.title} de Mi lista`" @click="$emit('remove', title)"><Icon name="trash" /></button>
    </div>
  </article>
</template>

<style scoped>
.lc { min-width: 0; }
.thumb {
  position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 12px; background: var(--bg-card);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb img.poster { object-position: 50% 22%; }
.thumb:hover { transform: scale(1.03); box-shadow: var(--shadow); }
.thumb:focus-visible { outline-offset: 3px; }
.fallback { display: grid; place-items: center; height: 100%; padding: 12px; text-align: center; font-weight: 700; background: linear-gradient(160deg, var(--bg-hover), var(--bg-card)); }
.info { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; }
.text { flex: 1; min-width: 0; }
.text p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { font-weight: 700; font-size: 1.05rem; }
.status { margin-top: 2px !important; font-size: 0.92rem; font-weight: 600; color: var(--accent); }
.langs { margin-top: 2px !important; font-size: 0.85rem; color: var(--text-dim); }
.del { flex: none; display: grid; place-items: center; width: 44px; height: 44px; min-height: 0; padding: 0; border-radius: 50%; background: none; color: var(--text-dim); }
.del:hover { background: var(--bg-hover); color: var(--danger); }
</style>
