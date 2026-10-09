<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.ts';
import { mergeSearch } from '../browse.ts';
import PosterGrid from '../components/PosterGrid.vue';
import type { TitleSummary } from '../types.ts';

const route = useRoute();
const q = computed(() => String(route.query.q ?? '').trim());
const items = ref<TitleSummary[] | null>(null);
const failed = ref(false);
let ticket = 0;

watch(
  q,
  async (text) => {
    const mine = ++ticket;
    failed.value = false;
    if (!text) return void (items.value = []);
    items.value = null;
    try {
      // ponytail: title search is local over the newest 200 titles (the server list cap); add a search endpoint past that.
      const [all, sug] = await Promise.all([api.titles(), api.suggest(text).catch(() => [])]);
      if (mine === ticket) items.value = mergeSearch(all, sug, text);
    } catch {
      if (mine === ticket) failed.value = true;
    }
  },
  { immediate: true },
);
</script>

<template>
  <main class="page">
    <div class="page-head">
      <h1>{{ q ? `Resultados para «${q}»` : 'Búsqueda' }}</h1>
      <span v-if="items?.length" class="count">{{ items.length }} {{ items.length === 1 ? 'título' : 'títulos' }}</span>
    </div>

    <p v-if="failed" class="error">No se pudo buscar. Revisa que el servidor esté encendido.</p>
    <p v-else-if="!items" class="muted" aria-busy="true">Buscando…</p>
    <div v-else-if="!items.length" class="state">
      <template v-if="q">
        <h2>Sin resultados para «{{ q }}»</h2>
        <p>Revisa la ortografía o prueba con otro título.</p>
      </template>
      <template v-else>
        <h2>¿Qué quieres ver?</h2>
        <p>Escribe un título en el buscador de arriba.</p>
      </template>
      <RouterLink class="pill primary" to="/browse">Ir al inicio</RouterLink>
    </div>
    <PosterGrid v-else :titles="items" />
  </main>
</template>

<style scoped>
.state { padding: 10vh 0; }
</style>
