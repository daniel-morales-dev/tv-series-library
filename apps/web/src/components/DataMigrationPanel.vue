<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.ts';
import { formatGb, migrationView, type DataPlan, type DataStatus } from '../dataMigration.ts';
import { showToast } from '../toast.ts';

const plan = ref<DataPlan | null>(null);
const status = ref<DataStatus | null>(null);
const error = ref('');
const busy = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const view = computed(() => (status.value ? migrationView(plan.value, status.value) : null));

async function load() {
  try {
    status.value = await api.dataStatus();
    // The plan walks the disk: skip it while a move is running (the status carries the progress).
    if (status.value.job.state !== 'running') plan.value = await api.dataPlan().catch(() => null);
  } catch {
    error.value = 'No se pudo consultar el estado de los datos.';
  }
}

function poll() {
  clearInterval(timer);
  timer = setInterval(async () => {
    try {
      status.value = await api.dataStatus();
      if (status.value.job.state !== 'running') {
        clearInterval(timer);
        await load();
      }
    } catch {
      // transient: the next tick retries
    }
  }, 2000);
}

async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await action();
    await load();
    if (status.value?.job.state === 'running') poll();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'No se pudo completar la acción.';
  } finally {
    busy.value = false;
  }
}

const start = () => run(() => api.startDataMove());
function free() {
  if (!window.confirm('Se borrará el video del origen (ya verificado en la biblioteca). No se puede deshacer. ¿Continuar?')) return;
  return run(async () => {
    const r = await api.freeDataOrigin();
    showToast(`Liberado: ${r.freedPackages} paquetes (${formatGb(r.freedBytes)}).`);
  });
}

onMounted(async () => {
  await load();
  if (status.value?.job.state === 'running') poll();
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section class="mig" aria-labelledby="mig-title">
    <h2 id="mig-title">Mover datos con la biblioteca</h2>
    <p class="help">Lleva el video procesado a <code>.sala/hls</code> dentro de la carpeta de contenido, para que viaje con el disco. El origen no se borra hasta que lo confirmes.</p>
    <p v-if="error" role="alert" class="err">{{ error }}</p>
    <div v-if="view" class="box">
      <p v-for="line in view.lines" :key="line">{{ line }}</p>
      <progress v-if="view.progress !== null" :value="view.progress" max="100" aria-label="Progreso del movimiento"></progress>
      <div class="row">
        <button v-if="view.stage === 'ready' || view.stage === 'failed'" type="button" class="primary" :disabled="busy || !view.canStart" @click="start">
          {{ view.stage === 'failed' ? 'Reanudar' : 'Mover datos' }}
        </button>
        <button v-if="view.canFree" type="button" class="primary" :disabled="busy" @click="free">Liberar espacio del origen</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.mig { display: grid; gap: 12px; }
h2, p { margin: 0; }
.help { color: var(--text-dim); }
.box { display: grid; gap: 8px; padding: 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg-card); overflow-wrap: anywhere; }
progress { width: 100%; }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
.err { color: #ff6b6b; }
</style>
