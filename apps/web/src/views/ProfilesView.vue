<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, clearProfileId, getProfileId } from '../api.ts';
import Avatar from '../components/Avatar.vue';
import Icon from '../components/Icon.vue';
import { selectProfile } from '../session.ts';
import type { Profile } from '../types.ts';

const router = useRouter();
const profiles = ref<Profile[] | null>(null);
const error = ref('');
const manage = ref(false);

/** `null` = closed, 0 = new profile, otherwise the id being renamed. */
const editing = ref<number | null>(null);
const name = ref('');
const confirmDelete = ref(false);
const field = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  try {
    profiles.value = await api.profiles();
    if (!profiles.value.length) openForm(0);
  } catch {
    error.value = 'No se pudo conectar con el servidor. Revisa que esté encendido y vuelve a intentar.';
  }
});

async function openForm(id: number, current = '') {
  editing.value = id;
  name.value = current;
  confirmDelete.value = false;
  error.value = '';
  await nextTick();
  field.value?.focus();
}

function choose(p: Profile) {
  if (manage.value) return void openForm(p.id, p.name);
  selectProfile(p);
  router.push('/browse');
}

async function save() {
  const value = name.value.trim();
  if (!value || !profiles.value) return;
  try {
    if (editing.value === 0) {
      const created = await api.createProfile(value);
      profiles.value.push(created);
      editing.value = null;
      if (!manage.value) choose(created);
    } else {
      const updated = await api.updateProfile(editing.value!, value);
      profiles.value = profiles.value.map((p) => (p.id === updated.id ? updated : p));
      editing.value = null;
    }
  } catch (e) {
    error.value = (e as Error).message === '409' ? 'Ya existe un perfil con ese nombre.' : 'No se pudo guardar el perfil.';
  }
}

async function remove() {
  const id = editing.value;
  if (!id || !profiles.value) return;
  try {
    await api.deleteProfile(id);
    profiles.value = profiles.value.filter((p) => p.id !== id);
    if (getProfileId() === id) clearProfileId();
    editing.value = null;
    if (!profiles.value.length) openForm(0);
  } catch {
    error.value = 'No se pudo eliminar el perfil.';
  }
}
</script>

<template>
  <main class="who">
    <h1>{{ profiles && !profiles.length ? 'Crea tu perfil' : '¿Quién está viendo?' }}</h1>
    <p v-if="error && !profiles" class="error">{{ error }}</p>
    <p v-else-if="!profiles" class="muted">Cargando…</p>

    <template v-else>
      <ul class="tiles">
        <li v-for="p in profiles" :key="p.id">
          <button class="tile" :class="{ manage }" @click="choose(p)">
            <span class="face" :style="{ '--size': '100%' }">
              <Avatar :profile="p" />
              <span v-if="manage" class="edit"><Icon name="pencil" :size="34" /></span>
            </span>
            <span class="label">{{ p.name }}</span>
          </button>
        </li>
        <li v-if="editing !== 0 && (profiles.length < 8)">
          <button class="tile add" @click="openForm(0)">
            <span class="face"><Icon name="plus" :size="56" /></span>
            <span class="label">Agregar perfil</span>
          </button>
        </li>
      </ul>

      <form v-if="editing !== null" class="form" @submit.prevent="save">
        <label>
          <span>{{ editing === 0 ? 'Nombre del nuevo perfil' : 'Nombre del perfil' }}</span>
          <input ref="field" v-model="name" maxlength="50" autocomplete="off" required />
        </label>
        <div class="actions">
          <button class="pill primary" type="submit">{{ editing === 0 ? 'Crear perfil' : 'Guardar' }}</button>
          <button v-if="profiles.length" class="pill" type="button" @click="editing = null">Cancelar</button>
          <template v-if="editing !== 0">
            <button v-if="!confirmDelete" class="pill danger" type="button" @click="confirmDelete = true">Eliminar</button>
            <button v-else class="pill danger on" type="button" @click="remove">Sí, eliminar perfil y su historial</button>
          </template>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </form>

      <button v-if="profiles.length" class="pill manage-btn" @click="manage = !manage; editing = null">
        {{ manage ? 'Listo' : 'Administrar perfiles' }}
      </button>
    </template>
  </main>
</template>

<style scoped>
.who {
  min-height: 100vh; max-width: none; margin: 0; padding: 8vh var(--gutter) 48px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; text-align: center;
  background: radial-gradient(1100px 600px at 50% -10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%), var(--bg);
}
h1 { margin: 0; font-size: clamp(1.8rem, 4vw, 3rem); letter-spacing: -0.02em; }
.tiles { display: flex; flex-wrap: wrap; justify-content: center; gap: clamp(16px, 3vw, 40px); margin: 0; padding: 0; list-style: none; }
.tile {
  display: flex; flex-direction: column; align-items: center; gap: 12px; width: clamp(110px, 16vw, 190px);
  min-height: 0; padding: 0; background: none; color: var(--text-dim);
}
.face {
  position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: 1; border-radius: 22%;
  overflow: hidden; transition: transform 0.18s;
}
.face :deep(.avatar) { width: 100%; height: 100%; font-size: clamp(2.6rem, 6vw, 5rem); border-radius: 0; }
.tile:hover { background: none; color: var(--text); }
.tile:hover .face, .tile:focus-visible .face { transform: scale(1.06); }
.tile:focus-visible { outline: none; color: var(--text); }
.tile:focus-visible .face { outline: 4px solid var(--focus); outline-offset: 4px; }
.label { font-size: 1.1rem; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.add .face { background: var(--bg-card); border: 2px dashed var(--line); color: var(--text-dim); }
.add:hover .face { border-color: var(--accent); color: var(--accent); }
.edit { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.55); color: #fff; }
.form { display: flex; flex-direction: column; gap: 16px; width: min(440px, 100%); padding: 24px; border-radius: 18px; background: var(--bg-raised); border: 1px solid var(--line); text-align: left; }
.form label { display: flex; flex-direction: column; gap: 8px; color: var(--text-dim); font-size: 0.9rem; }
.form input { width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; }
.pill.danger { background: none; color: var(--danger); box-shadow: inset 0 0 0 1.5px var(--danger); margin-left: auto; }
.pill.danger.on { background: var(--danger); color: #fff; }
.manage-btn { background: none; box-shadow: inset 0 0 0 1.5px var(--line); color: var(--text-dim); }
.manage-btn:hover { color: var(--text); background: none; box-shadow: inset 0 0 0 1.5px var(--text-dim); }
</style>
