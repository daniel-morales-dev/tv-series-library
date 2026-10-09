<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.ts';
import { facets, filtersToParams, filtersToQuery, isFiltered, parseFilters, type Filters } from '../browse.ts';
import FilterBar from '../components/FilterBar.vue';
import PosterGrid from '../components/PosterGrid.vue';
import { KIND_BY_SLUG, type KindSlug } from '../library.ts';
import type { TitleSummary } from '../types.ts';

const route = useRoute();
const router = useRouter();

const NAME: Record<KindSlug, string> = { series: 'Series', movies: 'Películas', anime: 'Anime' };
const slug = computed(() => route.params.kind as KindSlug);
const kind = computed(() => KIND_BY_SLUG[slug.value]);
const filters = computed(() => parseFilters(route.query));

const options = ref({ genres: [] as string[], years: [] as number[] });
const items = ref<TitleSummary[] | null>(null);
const failed = ref(false);
let ticket = 0;

// The filter options come from the whole section, so they don't shrink as you filter.
const optionCache = new Map<string, typeof options.value>();
async function loadOptions() {
  const k = kind.value;
  const cached = optionCache.get(k);
  if (cached) return void (options.value = cached);
  options.value = { genres: [], years: [] };
  const found = facets(await api.titlesBy(filtersToParams(k, parseFilters({}))));
  optionCache.set(k, found);
  if (k === kind.value) options.value = found;
}

watch(kind, () => loadOptions().catch(() => {}), { immediate: true });
watch(
  () => [kind.value, route.query.genre, route.query.year, route.query.sort],
  async () => {
    const mine = ++ticket;
    failed.value = false;
    items.value = null;
    try {
      const found = await api.titlesBy(filtersToParams(kind.value, filters.value));
      if (mine === ticket) items.value = found;
    } catch {
      if (mine === ticket) failed.value = true;
    }
  },
  { immediate: true },
);

const change = (f: Filters) => router.replace({ path: route.path, query: filtersToQuery(f) });
const clear = () => change({ ...filters.value, genre: null, year: null });
</script>

<template>
  <main class="page">
    <div class="page-head">
      <h1>{{ NAME[slug] }}</h1>
      <span v-if="items" class="count">{{ items.length }} {{ items.length === 1 ? 'título' : 'títulos' }}</span>
    </div>
    <FilterBar :filters="filters" :genres="options.genres" :years="options.years" @change="change" />

    <p v-if="failed" class="error">No se pudo cargar. Revisa que el servidor esté encendido.</p>
    <p v-else-if="!items" class="muted" aria-busy="true">Cargando…</p>
    <div v-else-if="!items.length" class="state">
      <template v-if="isFiltered(filters)">
        <h2>No hay títulos con estos filtros</h2>
        <p>Prueba con otro género o año.</p>
        <button class="pill primary" @click="clear">Quitar filtros</button>
      </template>
      <template v-else>
        <h2>Aún no hay {{ NAME[slug].toLowerCase() }}</h2>
        <p>Cuando agregues contenido de este tipo a la carpeta del servidor, aparecerá aquí.</p>
      </template>
    </div>
    <PosterGrid v-else :titles="items" />
  </main>
</template>

<style scoped>
.state { padding: 10vh 0; }
</style>
