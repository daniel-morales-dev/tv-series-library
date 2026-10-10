<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api.ts';
import type { AppConfig } from '../config.ts';
import ConfigForm from '../components/ConfigForm.vue';
import DataMigrationPanel from '../components/DataMigrationPanel.vue';
import NetworkPanel from '../components/NetworkPanel.vue';
import { showToast } from '../toast.ts';

const config = ref<AppConfig | null>(null);
const failed = ref(false);

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
onMounted(load);
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
    <NetworkPanel />
  </main>
</template>

<style scoped>
.settings { max-width: min(960px, 100%); margin: 0 auto; padding: calc(var(--header-h) + 24px) var(--gutter) 48px; display: grid; gap: 16px; }
h1, h2, dl { margin: 0; }
dt { color: var(--text-dim); font-size: 0.85rem; margin-top: 10px; }
dd { margin: 2px 0 0; overflow-wrap: anywhere; }
</style>
