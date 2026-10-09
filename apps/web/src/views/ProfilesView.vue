<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, setProfileId } from '../api.ts';
import type { Profile } from '../types.ts';

const router = useRouter();
const profiles = ref<Profile[] | null>(null);
const name = ref('');
const error = ref('');

onMounted(async () => {
  try {
    profiles.value = await api.profiles();
  } catch {
    error.value = 'No se pudo conectar con el servidor.';
  }
});

function choose(p: Profile) {
  setProfileId(p.id);
  router.push('/titles');
}

async function create() {
  if (!name.value.trim()) return;
  try {
    choose(await api.createProfile(name.value.trim()));
  } catch {
    error.value = 'No se pudo crear el perfil (¿el nombre ya existe?).';
  }
}
</script>

<template>
  <main>
    <h1>¿Quién está viendo?</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!profiles" class="muted">Cargando…</p>
    <template v-else>
      <div class="list">
        <button v-for="p in profiles" :key="p.id" @click="choose(p)">{{ p.name }}</button>
      </div>
      <h2>{{ profiles.length ? 'Nuevo perfil' : 'Crea tu perfil' }}</h2>
      <form @submit.prevent="create">
        <input v-model="name" placeholder="Nombre" maxlength="50" />
        <button type="submit">Crear</button>
      </form>
    </template>
  </main>
</template>

<style scoped>
.list { display: flex; flex-wrap: wrap; gap: 12px; }
form { display: flex; gap: 12px; flex-wrap: wrap; }
</style>
