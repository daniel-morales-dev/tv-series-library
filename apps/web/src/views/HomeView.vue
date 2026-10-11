<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, getProfileId } from '../api.ts';
import ContinueCard from '../components/ContinueCard.vue';
import HeroBanner from '../components/HeroBanner.vue';
import Icon from '../components/Icon.vue';
import TitleCard from '../components/TitleCard.vue';
import TitleRow from '../components/TitleRow.vue';
import { emptyLibraryHint, type AppConfig } from '../config.ts';
import { groupByGenre, pickHeroes } from '../library.ts';
import { hasHero, loadMyList, myList } from '../session.ts';
import { showToast } from '../toast.ts';
import type { ContinueItem, TitleSummary } from '../types.ts';

const router = useRouter();
const titles = ref<TitleSummary[]>([]);
const cont = ref<ContinueItem[]>([]);
const config = ref<AppConfig | null>(null);
const loading = ref(true);
const error = ref('');
const picking = ref(false);

const heroes = computed(() => pickHeroes(titles.value, cont.value));
const genres = computed(() => groupByGenre(titles.value));
const hint = computed(() => emptyLibraryHint(config.value));

async function loadConfig() {
  try {
    config.value = await api.config();
  } catch {
    // Only the empty state needs it; the hint falls back to the configure step.
  }
}

onMounted(async () => {
  const pid = getProfileId();
  if (!pid) return;
  try {
    const [t, c] = await Promise.all([api.titles(), api.continueWatching(pid), loadMyList(), loadConfig()]);
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

async function playRandom() {
  if (picking.value) return;
  picking.value = true;
  try {
    const pick = await api.random(getProfileId());
    router.push({ path: `/watch/${pick.mediaFileId}`, query: { title: String(pick.titleId) } });
  } catch (e) {
    showToast(e instanceof Error && e.message === '404' ? 'No hay nada listo para reproducir.' : 'No se pudo elegir un título al azar.');
  } finally {
    picking.value = false;
  }
}

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
    <h2>{{ hint.title }}</h2>
    <p>{{ hint.body }}</p>
    <RouterLink v-if="hint.action" class="pill primary" :to="hint.action.to">{{ hint.action.label }}</RouterLink>
    <RouterLink v-if="hint.link" class="pill" :to="hint.link.to">{{ hint.link.label }}</RouterLink>
  </main>
  <template v-else>
    <HeroBanner v-if="heroes.length" :picks="heroes" />
    <div v-else class="gap" />
    <div class="rows" :class="{ over: heroes.length }">
      <button class="random" :disabled="picking" :aria-busy="picking" @click="playRandom">
        <Icon name="dice" :size="20" /> {{ picking ? 'Buscando…' : 'Aleatorio' }}
      </button>
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
.random {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; margin: 0 var(--gutter) 12px; padding: 0 18px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--bg-raised); color: var(--text); font-weight: 600;
}
.random:hover:not(:disabled) { background: var(--bg-hover); }
.random:disabled { opacity: 0.6; }
.cont { --cc-w: clamp(250px, 24vw, 410px); }
@media (min-width: 1600px) {
  .rows { --card-w: 15vw; }
  .cont { --cc-w: 26vw; }
}
@media (max-width: 720px) {
  .rows { --card-w: 132px; }
  .rows.over { margin-top: -8px; }
  .cont { --cc-w: 72vw; }
}
</style>
