<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.ts';
import { suggestedFolder, type AppConfig, type LibraryCandidate } from '../config.ts';
import ConfigForm from '../components/ConfigForm.vue';

const router = useRouter();
const config = ref<AppConfig | null>(null);
const failed = ref(false);
const choosing = ref(false);
const candidates = ref<LibraryCandidate[]>([]);
const accepting = ref(false);
const acceptError = ref(false);

async function load() {
  failed.value = false;
  try {
    config.value = await api.config();
    if (config.value.status === 'ready') router.replace('/');
    candidates.value = [];
    if (config.value.status === 'missing') {
      // Suggestion only; a failed scan just means no suggestion.
      candidates.value = await api.configCandidates().then((r) => r.candidates, () => []);
    }
  } catch {
    failed.value = true;
  }
}

async function accept(path: string) {
  if (accepting.value) return;
  accepting.value = true;
  acceptError.value = false;
  try {
    await api.setContentDir(path);
    router.replace('/');
  } catch {
    acceptError.value = true;
  } finally {
    accepting.value = false;
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
        <div v-for="c in candidates" :key="c.path" class="found">
          <p>
            Encontramos tu biblioteca en <code>{{ c.path }}</code>
          </p>
          <button class="primary" :disabled="accepting" @click="accept(c.path)">Usar esta ubicación</button>
        </div>
        <p v-if="acceptError" role="alert">No se pudo usar esa ubicación. Intenta de nuevo.</p>
        <div class="row">
          <button :class="{ primary: !candidates.length }" @click="load">Reintentar</button>
          <button @click="choosing = true">Elegir otra carpeta</button>
        </div>
      </template>
      <template v-else>
        <h2>Elige tu carpeta de contenido</h2>
        <p>Es la carpeta donde guardas tus series y películas. Puedes cambiarla después en Ajustes.</p>
        <ConfigForm :suggested="suggestedFolder(config)" @saved="router.replace('/')" />
      </template>
    </template>
  </main>
</template>

<style scoped>
.setup { max-width: min(960px, 100%); margin: 0 auto; padding: 8vh var(--gutter); display: grid; gap: 14px; }
h1 { margin: 0; color: var(--accent); letter-spacing: -0.04em; }
h2, p { margin: 0; }
.found { display: grid; gap: 10px; justify-items: start; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
</style>
