<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { imageUrl } from '../api.ts';
import { KIND_LABEL, type HeroPick } from '../library.ts';
import { playTitle } from '../play.ts';
import Icon from './Icon.vue';

const props = defineProps<{ picks: HeroPick[] }>();
const router = useRouter();

const index = ref(0);
const paused = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let still = false;

function start() {
  clearInterval(timer);
  if (still || props.picks.length < 2) return;
  timer = setInterval(() => {
    if (!paused.value && !document.hidden) index.value = (index.value + 1) % props.picks.length;
  }, 10_000);
}
function go(i: number) {
  index.value = i;
  start();
}
onMounted(() => {
  still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  start();
});
onBeforeUnmount(() => clearInterval(timer));

const meta = (p: HeroPick) =>
  [KIND_LABEL[p.title.kind], p.title.year, ...p.title.genres.slice(0, 3)].filter(Boolean) as (string | number)[];

function play(p: HeroPick) {
  if (p.resume) router.push({ path: `/watch/${p.resume.mediaFileId}`, query: { title: p.title.id } });
  else playTitle(router, p.title.id);
}
</script>

<template>
  <section
    class="hero"
    aria-roledescription="carrusel"
    @pointerenter="paused = true"
    @pointerleave="paused = false"
    @focusin="paused = true"
    @focusout="paused = false"
  >
    <div
      v-for="(p, i) in picks"
      :key="p.title.id"
      class="slide"
      :class="{ on: i === index }"
      :inert="i !== index || undefined"
      :aria-hidden="i !== index"
    >
      <img class="bg" :src="imageUrl(p.title.backdropPath!)" alt="" :fetchpriority="i === 0 ? 'high' : 'auto'" draggable="false" />
      <div class="copy">
        <img v-if="p.title.logoPath" class="logo" :src="imageUrl(p.title.logoPath)" :alt="p.title.title" />
        <h1 v-else class="name">{{ p.title.title }}</h1>
        <span v-if="p.title.comingSoon" class="soon">Próximamente</span>
        <ul class="meta">
          <li v-for="m in meta(p)" :key="m">{{ m }}</li>
        </ul>
        <p v-if="p.title.overview" class="overview">{{ p.title.overview }}</p>
        <div class="btns">
          <button v-if="!p.title.comingSoon" class="pill primary" data-autofocus @click="play(p)">
            <Icon name="play" /> {{ p.resume ? 'Continuar' : 'Reproducir' }}
          </button>
          <RouterLink class="pill glass" :to="`/title/${p.title.id}`" :data-autofocus="p.title.comingSoon || undefined"><Icon name="info" /> Más info</RouterLink>
        </div>
      </div>
    </div>
    <div v-if="picks.length > 1" class="dots" role="tablist">
      <button
        v-for="(p, i) in picks"
        :key="p.title.id"
        role="tab"
        :aria-selected="i === index"
        :aria-label="p.title.title"
        :class="{ on: i === index }"
        @click="go(i)"
      />
    </div>
  </section>
</template>

<style scoped>
.hero { position: relative; height: clamp(480px, 72vh, 820px); overflow: hidden; background: #000; color: #fff; }
.slide { position: absolute; inset: 0; opacity: 0; transition: opacity 0.9s ease; }
.slide.on { opacity: 1; }
.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; }
.slide::after {
  content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background: linear-gradient(transparent 80%, var(--bg) 100%), linear-gradient(rgba(6, 6, 10, 0.55), transparent 22%);
}
/* Scrim único detrás del logo, el texto y los botones: cubre el hero completo (de la barra de
   arriba hasta abajo del contenedor), con degradado hacia la derecha y sin bordes visibles. */
.hero::after { content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none; background: linear-gradient(90deg, rgba(6, 6, 10, 0.85) 0%, rgba(6, 6, 10, 0.5) 40%, transparent 74%); }
.copy {
  position: absolute; z-index: 2; left: var(--gutter); bottom: clamp(60px, 14vh, 150px);
  width: min(34rem, calc(100% - 2 * var(--gutter))); display: flex; flex-direction: column; align-items: flex-start; gap: 14px;
}
.logo { max-width: min(420px, 80%); max-height: 150px; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 4px 18px rgba(0, 0, 0, 0.6)); }
.name { margin: 0; font-size: clamp(2.2rem, 5vw, 4rem); line-height: 1.02; letter-spacing: -0.02em; text-shadow: 0 4px 24px rgba(0, 0, 0, 0.6); }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin: 0; padding: 0; list-style: none; font-size: 0.95rem; font-weight: 600; color: #e6e6f0; }
.meta li + li::before { content: ''; display: inline-block; width: 4px; height: 4px; margin-right: 14px; vertical-align: middle; border-radius: 50%; background: var(--accent); }
.overview {
  margin: 0; max-width: 56ch; font-size: clamp(0.95rem, 1.2vw, 1.1rem); line-height: 1.5; color: #e9e9f2;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
}
.btns { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 6px; }
.dots { position: absolute; z-index: 3; right: var(--gutter); bottom: 34px; display: flex; gap: 8px; }
.dots button { width: 10px; height: 10px; min-height: 0; padding: 0; border-radius: 999px; background: rgba(255, 255, 255, 0.4); transition: width 0.25s, background 0.25s; }
.dots button:hover { background: rgba(255, 255, 255, 0.7); }
.dots button.on { width: 30px; background: var(--accent); }
@media (max-width: 720px) {
  .hero { height: clamp(460px, 74vh, 620px); }
  .hero::after { background: linear-gradient(90deg, rgba(6, 6, 10, 0.72), rgba(6, 6, 10, 0.25) 60%, transparent 88%); }
  .copy { bottom: 64px; gap: 10px; }
  .dots { left: var(--gutter); right: auto; bottom: 26px; }
}
</style>
