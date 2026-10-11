<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type OrphanScan } from '../api.ts';
import type { AppConfig } from '../config.ts';
import { formatGb } from '../dataMigration.ts';
import ConfigForm from '../components/ConfigForm.vue';
import DataMigrationPanel from '../components/DataMigrationPanel.vue';
import NetworkPanel from '../components/NetworkPanel.vue';
import { showToast } from '../toast.ts';

const config = ref<AppConfig | null>(null);
const failed = ref(false);
const orphans = ref<OrphanScan | null>(null);
const orphansFailed = ref(false);
const purging = ref(false);
const purged = ref<{ removed: number; bytesFreed: number } | null>(null);

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
onMounted(() => {
  void load();
  void loadOrphans();
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
    </template>
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
</style>
