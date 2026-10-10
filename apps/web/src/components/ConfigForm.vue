<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api.ts';
import { submitError } from '../config.ts';

const props = defineProps<{ suggested: string; initial?: string }>();
const emit = defineEmits<{ saved: [] }>();

const path = ref(props.initial ?? '');
const busy = ref(false);
const error = ref('');
const confirmCreate = ref(false);

async function save(create = false) {
  const value = path.value.trim();
  if (!value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.setContentDir(value, create);
    emit('saved');
  } catch (e) {
    const outcome = submitError(e instanceof Error ? e.message : '');
    confirmCreate.value = outcome.kind === 'confirm-create';
    if (outcome.kind === 'error') error.value = outcome.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="cfg" @submit.prevent="save()">
    <label for="content-dir">Carpeta de contenido</label>
    <input id="content-dir" v-model="path" type="text" autocomplete="off" spellcheck="false" placeholder="/ruta/a/tu/contenido" @input="confirmCreate = false" />
    <div class="row">
      <button type="button" @click="path = suggested; confirmCreate = false">Usar carpeta sugerida</button>
      <button type="submit" class="primary" :disabled="busy || !path.trim()">Guardar carpeta</button>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <div v-if="confirmCreate" class="confirm" role="alert">
      <p>La carpeta <code>{{ path.trim() }}</code> no existe. ¿Quieres crearla?</p>
      <div class="row">
        <button type="button" class="primary" :disabled="busy" @click="save(true)">Sí, crear carpeta</button>
        <button type="button" @click="confirmCreate = false">No</button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.cfg { display: grid; gap: 12px; }
.cfg input { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-raised); color: var(--text); }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
.err { margin: 0; color: var(--danger); }
.confirm { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-card); }
.confirm p { margin: 0 0 10px; }
</style>
