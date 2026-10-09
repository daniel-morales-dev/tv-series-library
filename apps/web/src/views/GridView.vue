<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.ts';
import TitleCard from '../components/TitleCard.vue';
import { KIND_BY_SLUG, type KindSlug } from '../library.ts';
import { loadMyList, myList } from '../session.ts';
import type { TitleSummary } from '../types.ts';

// Placeholder grid for T5d (filters, richer search): lists titles for Mi lista, a kind, or a search.
const route = useRoute();
const slug = computed(() => route.params.kind as KindSlug | undefined);
const heading = computed(() => {
  if (route.path === '/my-list') return 'Mi lista';
  if (route.path === '/search') return `Resultados para “${route.query.q ?? ''}”`;
  return { series: 'Series', movies: 'Películas', anime: 'Anime' }[slug.value!];
});
const fetched = ref<TitleSummary[] | null>(null);
const failed = ref(false);
const items = computed(() => (route.path === '/my-list' ? myList.value : fetched.value));

watchEffect(async () => {
  failed.value = false;
  try {
    if (route.path === '/my-list') return void (await loadMyList());
    fetched.value = null;
    if (route.path === '/search') {
      const q = String(route.query.q ?? '').toLowerCase();
      fetched.value = q ? (await api.titles()).filter((t) => `${t.title} ${t.originalTitle ?? ''}`.toLowerCase().includes(q)) : [];
    } else {
      fetched.value = await api.titles(KIND_BY_SLUG[slug.value!]);
    }
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <main class="page">
    <h1>{{ heading }}</h1>
    <p v-if="failed" class="error">No se pudo cargar. Revisa que el servidor esté encendido.</p>
    <p v-else-if="!items" class="muted">Cargando…</p>
    <div v-else-if="!items.length" class="state"><h2>Nada por aquí todavía</h2></div>
    <ul v-else class="grid">
      <li v-for="t in items" :key="t.id"><TitleCard :title="t" /></li>
    </ul>
  </main>
</template>

<style scoped>
.page { max-width: 1800px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(120px, 14vw, 220px), 1fr)); gap: 28px 18px; margin: 0; padding: 12px 0 0; list-style: none; }
</style>
