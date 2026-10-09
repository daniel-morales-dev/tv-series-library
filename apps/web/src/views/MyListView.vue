<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api, getProfileId } from '../api.ts';
import { SORT_LABEL, type Sort } from '../browse.ts';
import ListCard from '../components/ListCard.vue';
import { detailLanguages, restoreAt, sortMyList, statusLine } from '../listPage.ts';
import { loadMyList, myList } from '../session.ts';
import { showToast } from '../toast.ts';
import type { TitleDetail, TitleSummary } from '../types.ts';

const loading = ref(true);
const failed = ref(false);
const sort = ref<Sort>('recent');
const activity = ref<Record<number, string>>({});
// Details (progress + tracks) arrive after the grid so the cards show up at once.
const details = reactive(new Map<number, TitleDetail>());

const shown = computed(() => sortMyList(myList.value, sort.value, activity.value));
const info = (id: number) => {
  const d = details.get(id);
  return { status: d ? statusLine(d) : '', langs: d ? detailLanguages(d) : '' };
};

onMounted(async () => {
  const pid = getProfileId();
  if (!pid) return;
  try {
    const [, cont] = await Promise.all([loadMyList(), api.continueWatching(pid).catch(() => [])]);
    activity.value = Object.fromEntries(cont.map((c) => [c.title.id, c.updatedAt]));
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
  for (const t of myList.value) {
    api.title(t.id, pid).then((d) => details.set(t.id, d), () => {});
  }
});

async function remove(t: TitleSummary) {
  const pid = getProfileId();
  const index = myList.value.findIndex((x) => x.id === t.id);
  if (!pid || index < 0) return;
  myList.value = myList.value.filter((x) => x.id !== t.id);
  try {
    await api.removeFromMyList(pid, t.id);
  } catch {
    myList.value = restoreAt(myList.value, t, index);
    return showToast('No se pudo quitar. Inténtalo de nuevo.');
  }
  showToast(`«${t.title}» se quitó de Mi lista`, {
    label: 'Deshacer',
    run: async () => {
      myList.value = restoreAt(myList.value, t, index);
      try {
        await api.addToMyList(pid, t.id);
      } catch {
        myList.value = myList.value.filter((x) => x.id !== t.id);
        showToast('No se pudo deshacer.');
      }
    },
  });
}
</script>

<template>
  <main class="page">
    <div class="page-head">
      <h1>Mi lista</h1>
      <span v-if="myList.length" class="count">{{ myList.length }} {{ myList.length === 1 ? 'título' : 'títulos' }}</span>
    </div>

    <p v-if="failed" class="error">No se pudo cargar. Revisa que el servidor esté encendido.</p>
    <p v-else-if="loading" class="muted" aria-busy="true">Cargando…</p>
    <div v-else-if="!myList.length" class="state">
      <h2>Tu lista está vacía</h2>
      <p>Toca el + en cualquier título para guardarlo aquí y retomarlo cuando quieras.</p>
      <RouterLink class="pill primary" to="/browse">Explorar el catálogo</RouterLink>
    </div>
    <template v-else>
      <div class="toolbar">
        <select v-model="sort" class="field" aria-label="Orden">
          <option value="recent">Orden: Actividad reciente</option>
          <option v-for="s in (['title', 'year'] as const)" :key="s" :value="s">Orden: {{ SORT_LABEL[s] }}</option>
        </select>
      </div>
      <ul class="list-grid">
        <li v-for="t in shown" :key="t.id"><ListCard :title="t" :status="info(t.id).status" :langs="info(t.id).langs" @remove="remove" /></li>
      </ul>
    </template>
  </main>
</template>

<style scoped>
.state { padding: 10vh 0; }
.list-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(clamp(250px, 22vw, 400px), 1fr)); gap: 30px 22px; margin: 0; padding: 0; list-style: none; }
</style>
