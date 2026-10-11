<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api.ts';
import { submitError } from '../config.ts';
import { startPath } from '../folderPicker.ts';
import FolderPicker from './FolderPicker.vue';
import Icon from './Icon.vue';

const props = defineProps<{ suggested: string; initial?: string }>();
const emit = defineEmits<{ saved: []; path: [value: string] }>();

const path = ref(props.initial ?? '');
const busy = ref(false);
const error = ref('');
const confirmCreate = ref(false);
const browsing = ref(false);

watch(path, (value) => emit('path', value), { immediate: true });

/** Lets the wizard swap the typed path for its "use the parent folder" suggestion. */
function usePath(value: string) {
  path.value = value;
  confirmCreate.value = false;
}
defineExpose({ usePath });

function picked(value: string) {
  path.value = value;
  confirmCreate.value = false;
  browsing.value = false;
}

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
    <div class="field">
      <input id="content-dir" v-model="path" type="text" autocomplete="off" spellcheck="false" :placeholder="suggested || 'Ruta completa de la carpeta'" @input="confirmCreate = false" />
      <button type="button" class="browse" aria-label="Explorar carpetas" title="Explorar carpetas" @click="browsing = true">
        <Icon name="folder" :size="20" /><span>Explorar</span>
      </button>
    </div>
    <div class="row">
      <button v-if="suggested" type="button" @click="path = suggested; confirmCreate = false">Usar carpeta sugerida</button>
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
    <FolderPicker v-if="browsing" :start="startPath(path)" @pick="picked" @close="browsing = false" />
  </form>
</template>

<style scoped>
.cfg { display: grid; gap: 12px; min-width: 0; }
.field { display: flex; gap: 10px; min-width: 0; }
.browse { flex: none; display: inline-flex; align-items: center; gap: 8px; }
.cfg input { width: 100%; min-width: 0; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-raised); color: var(--text); }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
.err { margin: 0; color: var(--danger); }
.confirm { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-card); }
.confirm p { margin: 0 0 10px; }
</style>
