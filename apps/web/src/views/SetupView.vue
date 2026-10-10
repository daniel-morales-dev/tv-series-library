<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.ts';
import type { AppConfig } from '../config.ts';
import ConfigForm from '../components/ConfigForm.vue';

const router = useRouter();
const config = ref<AppConfig | null>(null);
const failed = ref(false);
const choosing = ref(false);

async function load() {
  failed.value = false;
  try {
    config.value = await api.config();
    if (config.value.status === 'ready') router.replace('/');
  } catch {
    failed.value = true;
  }
}
onMounted(load);
</script>

<template>
  <main class="setup">
    <h1>sala</h1>
    <p v-if="failed" role="alert">No se pudo contactar con el servidor. <button @click="load">Reintentar</button></p>
    <template v-else-if="config">
      <template v-if="config.status === 'missing' && !choosing">
        <h2>No encuentro tu carpeta de contenido</h2>
        <p>
          <code>{{ config.contentDir }}</code> no está disponible. Si es un disco externo, conéctalo y reintenta. No se borró ni se creó nada.
        </p>
        <div class="row">
          <button class="primary" @click="load">Reintentar</button>
          <button @click="choosing = true">Elegir otra carpeta</button>
        </div>
      </template>
      <template v-else>
        <h2>Elige tu carpeta de contenido</h2>
        <p>Es la carpeta donde guardas tus series y películas. Puedes cambiarla después en Ajustes.</p>
        <ConfigForm :suggested="config.suggestedDefault" @saved="router.replace('/')" />
      </template>
    </template>
  </main>
</template>

<style scoped>
.setup { max-width: min(960px, 100%); margin: 0 auto; padding: 8vh var(--gutter); display: grid; gap: 14px; }
h1 { margin: 0; color: var(--accent); letter-spacing: -0.04em; }
h2, p { margin: 0; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
</style>
