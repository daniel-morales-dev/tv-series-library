<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, getProfileId, imageUrl } from '../api.ts';
import { fileStatus, needsPolling } from '../fileStatus.ts';
import type { Job, MediaFile, TitleDetail } from '../types.ts';

const route = useRoute();
const detail = ref<TitleDetail | null>(null);
const jobs = ref<Job[]>([]);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  try {
    const [d, j] = await Promise.all([api.title(Number(route.params.id), getProfileId() ?? 0), api.jobs()]);
    detail.value = d;
    jobs.value = j;
    error.value = '';
  } catch {
    error.value = 'No se pudo cargar el título.';
  }
  if (detail.value && needsPolling(detail.value.files)) timer = setTimeout(load, 5000);
}

onMounted(load);
onUnmounted(() => clearTimeout(timer));

const status = (f: MediaFile) => fileStatus(f, jobs.value);
const filesOf = (episodeId: number) => detail.value?.files.filter((f) => f.episodeId === episodeId) ?? [];
const extras = computed(() => detail.value?.files.filter((f) => f.extraLabel) ?? []);
</script>

<template>
  <main>
    <p><RouterLink class="btn" to="/titles">← Títulos</RouterLink></p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!detail" class="muted">Cargando…</p>
    <template v-else>
      <div class="head">
        <img v-if="detail.posterPath" :src="imageUrl(detail.posterPath)" :alt="detail.title" />
        <div>
          <h1>{{ detail.title }}</h1>
          <p class="muted">{{ detail.year ?? '' }}</p>
          <p>{{ detail.overview }}</p>
        </div>
      </div>

      <section v-for="s in detail.seasons" :key="s.id">
        <h2>{{ s.name || `Temporada ${s.number}` }}</h2>
        <ul>
          <li v-for="e in s.episodes" :key="e.id">
            <span class="ep">{{ e.number }}. {{ e.name }}</span>
            <span v-if="!filesOf(e.id).length" class="muted">sin archivo</span>
            <RouterLink v-for="f in filesOf(e.id)" :key="f.id" class="btn" :class="status(f).kind" :to="`/watch/${f.id}?title=${detail.id}`">
              {{ status(f).label }}<small v-if="status(f).detail"> · {{ status(f).detail }}</small>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section v-if="extras.length">
        <h2>Extras</h2>
        <ul>
          <li v-for="f in extras" :key="f.id">
            <span class="ep">{{ f.extraLabel }}</span>
            <RouterLink class="btn" :class="status(f).kind" :to="`/watch/${f.id}?title=${detail.id}`">
              {{ status(f).label }}<small v-if="status(f).detail"> · {{ status(f).detail }}</small>
            </RouterLink>
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>

<style scoped>
.head { display: flex; gap: 20px; flex-wrap: wrap; }
.head img { width: 160px; border-radius: 8px; align-self: flex-start; }
.head > div { flex: 1 1 280px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid #25252d; }
.ep { flex: 1 1 200px; }
.ready { background: #1f4d2e; }
.processing { background: #5a4a14; }
.queued { background: #2b2b35; }
.error { background: #5a1f1f; color: inherit; }
</style>
