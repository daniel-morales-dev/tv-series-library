<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.ts';
import { suggestedFolder, type AppConfig, type LibraryCandidate } from '../config.ts';
import ConfigForm from '../components/ConfigForm.vue';
import { layoutDiagram, parentIfMediaRoot, pathSeparator, stepLabel, tmdbGuide, tmdbSkipNote } from '../onboarding.ts';

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

const step = ref(1);
const folder = ref('');
const typedPath = ref('');
const folderForm = ref<InstanceType<typeof ConfigForm> | null>(null);
const tmdbChoice = ref<'have' | 'get' | 'skip' | null>(null);
const tmdbToken = ref('');
const tmdbBusy = ref(false);
const tmdbOk = ref(false);
const tmdbError = ref('');

const suggested = computed(() => (config.value ? suggestedFolder(config.value) : ''));
const sep = computed(() => pathSeparator(folder.value || suggested.value));
const diagram = computed(() => layoutDiagram(sep.value));
const mediaParent = computed(() => parentIfMediaRoot(typedPath.value));
const hasToken = computed(() => tmdbOk.value || config.value?.tmdbConfigured === true);

async function folderSaved() {
  folder.value = typedPath.value.trim();
  try {
    config.value = await api.config();
  } catch {
    // Step 2 reports its own errors; a stale config only affects the "ya tienes token" shortcut.
  }
  step.value = 2;
}

async function saveAndTest() {
  if (tmdbBusy.value || !tmdbToken.value.trim()) return;
  tmdbBusy.value = true;
  tmdbError.value = '';
  try {
    await api.setTmdbToken(tmdbToken.value);
    tmdbToken.value = '';
    await api.testTmdbToken('');
    tmdbOk.value = true;
    step.value = 3;
  } catch (err) {
    tmdbError.value = err instanceof Error ? err.message : 'No se pudo guardar el token.';
  } finally {
    tmdbBusy.value = false;
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
        <p class="step">{{ stepLabel(step) }}</p>

        <section v-if="step === 1" class="wiz">
          <h2>Elige tu carpeta de Sala</h2>
          <p>Elige la carpeta donde vivirá tu biblioteca, no <code>shows</code> ni <code>films</code>: Sala crea esas dos por sí sola. Puedes cambiarla después en Ajustes.</p>
          <pre class="diagram" aria-label="Estructura de carpetas">{{ diagram }}</pre>
          <div v-if="mediaParent" class="warn" role="alert">
            <p>Parece que elegiste una subcarpeta. Mejor usa <code>{{ mediaParent }}</code>.</p>
            <button type="button" @click="folderForm?.usePath(mediaParent)">Usar la carpeta de arriba</button>
          </div>
          <ConfigForm ref="folderForm" :suggested="suggested" :initial="suggested" @path="typedPath = $event" @saved="folderSaved" />
        </section>

        <section v-else-if="step === 2" class="wiz">
          <h2>Metadata de TMDB (opcional)</h2>
          <template v-if="hasToken">
            <p>Ya tienes un token configurado ✓</p>
            <button class="primary" @click="step = 3">Continuar</button>
          </template>
          <template v-else>
            <p>¿Ya tienes tu token de TMDB?</p>
            <div class="row">
              <button :class="{ primary: tmdbChoice === 'have' }" @click="tmdbChoice = 'have'">Sí, lo tengo</button>
              <button :class="{ primary: tmdbChoice === 'get' }" @click="tmdbChoice = 'get'">No, quiero conseguirlo</button>
              <button :class="{ primary: tmdbChoice === 'skip' }" @click="tmdbChoice = 'skip'">Saltar por ahora</button>
            </div>
            <ol v-if="tmdbChoice === 'get'" class="guide">
              <li v-for="(item, i) in tmdbGuide" :key="item">
                {{ item }}
                <a v-if="i === 1" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org/settings/api</a>
              </li>
            </ol>
            <form v-if="tmdbChoice === 'have' || tmdbChoice === 'get'" class="tmdb" @submit.prevent="saveAndTest">
              <label for="setup-tmdb">{{ tmdbChoice === 'get' ? 'Pégalo aquí' : 'Token de TMDB' }}</label>
              <input id="setup-tmdb" v-model="tmdbToken" type="password" autocomplete="off" spellcheck="false" />
              <button type="submit" class="primary" :disabled="tmdbBusy || !tmdbToken.trim()">Guardar y probar</button>
              <p v-if="tmdbError" role="alert" class="err">{{ tmdbError }}</p>
            </form>
            <template v-if="tmdbChoice === 'skip'">
              <p>{{ tmdbSkipNote }}</p>
              <button class="primary" @click="step = 3">Continuar</button>
            </template>
          </template>
        </section>

        <section v-else class="wiz">
          <h2>¡Listo!</h2>
          <ul class="summary">
            <li>Carpeta: <code>{{ folder }}</code></li>
            <li>TMDB: {{ hasToken ? 'Token válido ✓' : 'sin token (puedes agregarlo en Ajustes)' }}</li>
          </ul>
          <p>
            Pon tus series en <code>{{ folder }}{{ sep }}shows</code> y tus películas en <code>{{ folder }}{{ sep }}films</code>.
          </p>
          <button class="primary" @click="router.replace('/')">Ir a mi biblioteca</button>
        </section>
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
.step { color: var(--text-dim); font-size: 0.9rem; }
.wiz { display: grid; gap: 14px; justify-items: start; min-width: 0; }
.wiz :deep(.cfg), .tmdb { width: 100%; }
.diagram { margin: 0; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-card); overflow-x: auto; max-width: 100%; }
.warn { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-card); display: grid; gap: 10px; justify-items: start; }
.guide { margin: 0; padding-left: 1.4em; display: grid; gap: 6px; }
.tmdb { display: grid; gap: 8px; justify-items: start; }
.tmdb input { width: 100%; min-width: 0; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-raised); color: var(--text); }
.summary { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; }
.err { margin: 0; color: var(--danger); }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
</style>
