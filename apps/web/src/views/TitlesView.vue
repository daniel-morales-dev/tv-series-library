<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, imageUrl } from '../api.ts';
import type { TitleSummary } from '../types.ts';

const titles = ref<TitleSummary[] | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    titles.value = await api.titles();
  } catch {
    error.value = 'No se pudo cargar el catálogo.';
  }
});
</script>

<template>
  <main>
    <h1>Títulos</h1>
    <p><RouterLink class="btn" to="/">Cambiar de perfil</RouterLink></p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!titles" class="muted">Cargando…</p>
    <p v-else-if="!titles.length" class="muted">Aún no hay títulos.</p>
    <ul v-else class="grid">
      <li v-for="t in titles" :key="t.id">
        <RouterLink :to="`/titles/${t.id}`">
          <img v-if="t.posterPath" :src="imageUrl(t.posterPath)" :alt="t.title" loading="lazy" />
          <div v-else class="noposter">Sin póster</div>
          <span>{{ t.title }}</span>
          <small class="muted">{{ t.year ?? '' }}</small>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
a { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 10px; }
a:hover, a:focus-visible { background: #2b2b35; outline: 3px solid #7aa7ff; }
img, .noposter { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 8px; background: #1a1a20; }
.noposter { display: grid; place-items: center; color: #a0a0ad; }
</style>
