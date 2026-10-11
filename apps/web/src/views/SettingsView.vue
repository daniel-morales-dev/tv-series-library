<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type LibraryRoot, type OrphanScan } from '../api.ts';
import { tmdbSectionState, type AppConfig } from '../config.ts';
import { formatGb } from '../dataMigration.ts';
import ConfigForm from '../components/ConfigForm.vue';
import DataMigrationPanel from '../components/DataMigrationPanel.vue';
import FolderPicker from '../components/FolderPicker.vue';
import NetworkPanel from '../components/NetworkPanel.vue';
import { showToast } from '../toast.ts';

const config = ref<AppConfig | null>(null);
const failed = ref(false);
const orphans = ref<OrphanScan | null>(null);
const orphansFailed = ref(false);
const purging = ref(false);
const purged = ref<{ removed: number; bytesFreed: number } | null>(null);
const roots = ref<LibraryRoot[] | null>(null);
const rootsFailed = ref(false);
const rootsNotice = ref('');
const rootsNoticeBad = ref(false);
const rootsBusy = ref(false);
const picking = ref(false);
const tmdbToken = ref('');
const tmdbBusy = ref(false);
const tmdbFeedback = ref<{ bad: boolean; text: string } | null>(null);
const tmdbState = computed(() => tmdbSectionState(config.value, tmdbToken.value, tmdbBusy.value));

async function saveTmdbToken() {
  if (tmdbBusy.value) return;
  tmdbBusy.value = true;
  try {
    const result = await api.setTmdbToken(tmdbToken.value);
    tmdbToken.value = ''; // the token is never kept in the form after saving
    tmdbFeedback.value = { bad: false, text: result.message };
    await load();
  } catch (err) {
    tmdbFeedback.value = { bad: true, text: err instanceof Error ? err.message : 'No se pudo guardar el token.' };
  } finally {
    tmdbBusy.value = false;
  }
}

async function testTmdbToken() {
  if (!tmdbState.value.canTest) return;
  tmdbBusy.value = true;
  try {
    const result = await api.testTmdbToken(tmdbToken.value);
    tmdbFeedback.value = { bad: false, text: result.message };
  } catch (err) {
    tmdbFeedback.value = { bad: true, text: err instanceof Error ? err.message : 'No se pudo probar el token.' };
  } finally {
    tmdbBusy.value = false;
  }
}

async function load() {
  try {
    config.value = await api.config();
  } catch {
    failed.value = true;
  }
}
async function saved() {
  await load();
  showToast('Carpeta actualizada.');
}
async function loadOrphans() {
  try {
    orphans.value = await api.orphans();
  } catch {
    orphansFailed.value = true;
  }
}
async function purgeOrphans() {
  if (!orphans.value?.count) return;
  const ok = window.confirm(
    `Se eliminarán ${orphans.value.count} paquetes huérfanos (${formatGb(orphans.value.bytes)}). No se puede deshacer. ¿Continuar?`,
  );
  if (!ok) return;
  purging.value = true;
  try {
    purged.value = await api.purgeOrphans();
    await loadOrphans();
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'No se pudo limpiar los paquetes huérfanos.');
  } finally {
    purging.value = false;
  }
}

async function loadRoots() {
  try {
    roots.value = (await api.roots()).roots;
  } catch {
    rootsFailed.value = true;
  }
}

function say(text: string, bad = false) {
  rootsNotice.value = text;
  rootsNoticeBad.value = bad;
}

async function addRoot(path: string) {
  picking.value = false;
  rootsBusy.value = true;
  try {
    await api.addRoot(path);
    say('Ubicación agregada.');
    await loadRoots();
  } catch (err) {
    say(err instanceof Error ? err.message : 'No se pudo agregar la ubicación.', true);
  } finally {
    rootsBusy.value = false;
  }
}

async function useSuggestion(root: LibraryRoot) {
  if (!root.suggestion || rootsBusy.value) return;
  rootsBusy.value = true;
  try {
    await api.relocateRoot(root.id, root.suggestion);
    say('Ubicación actualizada.');
    await loadRoots();
  } catch (err) {
    say(err instanceof Error ? err.message : 'No se pudo actualizar la ubicación.', true);
  } finally {
    rootsBusy.value = false;
  }
}

async function forget(root: LibraryRoot) {
  if (rootsBusy.value) return;
  const name = root.label ?? root.path ?? 'esta ubicación';
  const ok = window.confirm(`¿Olvidar la ubicación «${name}»? Sus títulos quedarán como no disponibles; los archivos no se borran.`);
  if (!ok) return;
  rootsBusy.value = true;
  try {
    await api.forgetRoot(root.id);
    say('Ubicación olvidada.');
    await loadRoots();
  } catch (err) {
    say(err instanceof Error ? err.message : 'No se pudo olvidar la ubicación.', true);
  } finally {
    rootsBusy.value = false;
  }
}

onMounted(() => {
  void load();
  void loadOrphans();
  void loadRoots();
});
</script>

<template>
  <main class="settings">
    <h1>Ajustes</h1>
    <p v-if="failed" role="alert">No se pudo cargar la configuración.</p>
    <template v-else-if="config">
      <dl>
        <dt>Carpeta actual</dt>
        <dd v-if="config.contentDir"><code>{{ config.contentDir }}</code></dd>
        <dd v-else-if="config.status === 'unset'">
          Carpeta definida por la configuración de desarrollo (.env) o la sugerida: <code>{{ config.suggestedDefault }}</code>
        </dd>
        <dd v-else><code>Sin configurar</code></dd>
        <dt>Identificador de la biblioteca</dt>
        <dd><code>{{ config.libraryId ?? '—' }}</code></dd>
      </dl>
      <h2>Cambiar carpeta</h2>
      <ConfigForm :key="config.contentDir ?? ''" :suggested="config.suggestedDefault" :initial="config.contentDir ?? ''" @saved="saved" />
      <section aria-labelledby="tmdb-title">
        <h2 id="tmdb-title">TMDB</h2>
        <p class="help">Token de acceso de lectura de TMDB. Con él la biblioteca busca portadas, sinopsis y episodios; sin token, la ingesta funciona sin conexión.</p>
        <p class="tmdb-state">Estado: <b>{{ tmdbState.state }}</b></p>
        <form class="tmdb-form" @submit.prevent="saveTmdbToken">
          <label for="tmdb-token">Token de TMDB</label>
          <input id="tmdb-token" v-model="tmdbToken" type="password" autocomplete="off" spellcheck="false" />
          <div class="tmdb-actions">
            <button type="submit" class="primary" :disabled="!tmdbState.canSave">Guardar</button>
            <button type="button" :disabled="!tmdbState.canTest" @click="testTmdbToken">Probar</button>
          </div>
        </form>
        <p v-if="tmdbFeedback" role="status" :class="{ bad: tmdbFeedback.bad }">{{ tmdbFeedback.text }}</p>
      </section>
    </template>
    <section aria-labelledby="roots-title">
      <h2 id="roots-title">Ubicaciones</h2>
      <p class="help">Carpetas donde vive el contenido. Si un disco no está conectado, sus títulos aparecen como «No disponible» y el progreso se conserva.</p>
      <p v-if="rootsFailed" role="alert">No se pudo cargar las ubicaciones.</p>
      <template v-else-if="roots">
        <ul class="roots">
          <li v-for="r in roots" :key="r.id" class="root">
            <div class="root-head">
              <b>{{ r.label ?? r.path ?? 'Sin ruta' }}</b>
              <span class="state" :class="r.present ? 'ok' : 'off'">{{ r.present ? 'Presente' : 'No disponible' }}</span>
            </div>
            <p class="root-meta"><code>{{ r.path ?? r.lastKnownPath ?? '—' }}</code> · {{ r.files }} {{ r.files === 1 ? 'archivo' : 'archivos' }}</p>
            <p v-if="r.suggestion" class="root-suggestion">
              La biblioteca se encontró en <code>{{ r.suggestion }}</code>.
              <button type="button" :disabled="rootsBusy" @click="useSuggestion(r)">Usar esta ubicación</button>
            </p>
            <button v-if="r.id !== 1" type="button" :disabled="rootsBusy" @click="forget(r)">Olvidar</button>
          </li>
        </ul>
        <button type="button" class="primary" :disabled="rootsBusy" @click="picking = true">Agregar ubicación</button>
        <p v-if="rootsNotice" role="status" :class="{ bad: rootsNoticeBad }">{{ rootsNotice }}</p>
      </template>
      <FolderPicker v-if="picking" @pick="addRoot" @close="picking = false" />
    </section>
    <DataMigrationPanel v-if="config?.contentDir" />
    <section aria-labelledby="maint-title">
      <h2 id="maint-title">Mantenimiento</h2>
      <p class="help">Paquetes HLS que ya no pertenecen a ningún archivo de la biblioteca (por ejemplo, tras reemplazar un release).</p>
      <p v-if="orphansFailed" role="alert">No se pudo consultar los paquetes huérfanos.</p>
      <template v-else-if="orphans">
        <p v-if="orphans.count === 0">No hay paquetes huérfanos.</p>
        <template v-else>
          <p>{{ orphans.count }} paquetes huérfanos ({{ formatGb(orphans.bytes) }}).</p>
          <button type="button" class="primary" :disabled="purging" @click="purgeOrphans">Limpiar paquetes huérfanos</button>
        </template>
        <p v-if="purged" role="status">{{ purged.removed }} paquetes eliminados, {{ formatGb(purged.bytesFreed) }} liberados.</p>
      </template>
    </section>
    <NetworkPanel />
  </main>
</template>

<style scoped>
.settings { max-width: min(960px, 100%); margin: 0 auto; padding: calc(var(--header-h) + 24px) var(--gutter) 48px; display: grid; gap: 16px; }
h1, h2, dl { margin: 0; }
dt { color: var(--text-dim); font-size: 0.85rem; margin-top: 10px; }
dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.help { color: var(--text-dim); font-size: 0.9rem; margin: 4px 0 0; }
section p { margin: 8px 0 0; }
.primary { margin-top: 8px; background: var(--accent); color: var(--accent-ink); font-weight: 700; }
.roots { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
.root { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-card); }
.root-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.root-head b { overflow-wrap: anywhere; }
.state { flex: none; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: var(--bg-hover); color: var(--text-dim); }
.state.ok { color: #4cc38a; }
.state.off { color: #ff9b9b; }
.root-meta { color: var(--text-dim); font-size: 0.9rem; overflow-wrap: anywhere; }
.root button { margin-top: 8px; }
.tmdb-state { color: var(--text-dim); font-size: 0.9rem; }
.tmdb-form { display: grid; gap: 6px; margin-top: 8px; }
.tmdb-form label { color: var(--text-dim); font-size: 0.85rem; }
.tmdb-actions { display: flex; gap: 8px; }
.tmdb-actions .primary { margin-top: 0; }
.bad { color: var(--danger); }
</style>
