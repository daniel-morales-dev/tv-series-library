<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, getProfileId } from '../api.ts';
import ContinueCard from '../components/ContinueCard.vue';
import HeroBanner from '../components/HeroBanner.vue';
import TitleCard from '../components/TitleCard.vue';
import TitleRow from '../components/TitleRow.vue';
import { groupByGenre, pickHeroes } from '../library.ts';
import { hasHero, loadMyList, myList } from '../session.ts';
import type { ContinueItem, TitleSummary } from '../types.ts';

const titles = ref<TitleSummary[]>([]);
const cont = ref<ContinueItem[]>([]);
const loading = ref(true);
const error = ref('');

const heroes = computed(() => pickHeroes(titles.value, cont.value));
const genres = computed(() => groupByGenre(titles.value));

onMounted(async () => {
  const pid = getProfileId();
  if (!pid) return;
  try {
    const [t, c] = await Promise.all([api.titles(), api.continueWatching(pid), loadMyList()]);
    titles.value = t;
    cont.value = c;
    hasHero.value = heroes.value.length > 0;
  } catch {
    error.value = 'No se pudo cargar tu biblioteca. Revisa que el servidor esté encendido.';
  } finally {
    loading.value = false;
  }
});
onBeforeUnmount(() => (hasHero.value = false));

async function removeContinue(titleId: number) {
  const pid = getProfileId();
  const at = cont.value.findIndex((c) => c.title.id === titleId);
  if (!pid || at < 0) return;
  const [item] = cont.value.splice(at, 1);
  try {
    await api.removeContinue(pid, titleId);
  } catch {
    cont.value.splice(at, 0, item!);
  }
}
</script>

<template>
  <div v-if="loading" class="skeleton" aria-busy="true" />
  <main v-else-if="error" class="page state">
    <h2>Sin conexión</h2>
    <p>{{ error }}</p>
  </main>
  <main v-else-if="!titles.length" class="page state">
    <h2>Tu biblioteca está vacía</h2>
    <p>Pon tus series y películas en la carpeta de contenido del servidor; aparecerán aquí al escanear.</p>
  </main>
  <template v-else>
    <HeroBanner v-if="heroes.length" :picks="heroes" />
    <div v-else class="gap" />
    <div class="rows" :class="{ over: heroes.length }">
      <TitleRow class="cont" title="Continuar viendo" :items="cont" :key-of="(c) => c.title.id">
        <template #default="{ item }"><ContinueCard :item="item" @remove="removeContinue" /></template>
      </TitleRow>
      <TitleRow title="Mi lista" :items="myList" :key-of="(t) => t.id">
        <template #default="{ item }"><TitleCard :title="item" /></template>
      </TitleRow>
      <TitleRow title="Agregados recientemente" :items="titles" :key-of="(t) => t.id">
        <template #default="{ item }"><TitleCard :title="item" /></template>
      </TitleRow>
      <TitleRow v-for="g in genres" :key="g.genre" :title="g.genre" :items="g.titles" :key-of="(t) => t.id">
        <template #default="{ item }"><TitleCard :title="item" /></template>
      </TitleRow>
    </div>
  </template>
</template>

<style scoped>
.skeleton {
  height: clamp(480px, 72vh, 820px);
  background: linear-gradient(100deg, var(--bg-raised) 30%, var(--bg-card) 50%, var(--bg-raised) 70%) 0 0 / 300% 100%;
  animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer { to { background-position: -300% 0; } }
.gap { height: var(--header-h); }
.rows { --card-w: clamp(128px, 13.5vw, 230px); position: relative; z-index: 2; padding-bottom: 80px; }
.rows.over { margin-top: clamp(-90px, -9vh, -40px); }
.cont { --cc-w: clamp(250px, 24vw, 410px); }
@media (max-width: 720px) {
  .rows { --card-w: 122px; }
  .rows.over { margin-top: -8px; }
  .cont { --cc-w: 72vw; }
}
</style>
