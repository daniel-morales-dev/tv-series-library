<script setup lang="ts">
import { computed } from 'vue';
import { SORT_LABEL, type Filters, type Sort } from '../browse.ts';

const props = defineProps<{ filters: Filters; genres: string[]; years: number[] }>();
const emit = defineEmits<{ change: [filters: Filters] }>();

// A year from the URL that isn't in the library still has to show in the select.
const yearOptions = computed(() => (props.filters.year && !props.years.includes(props.filters.year) ? [props.filters.year, ...props.years] : props.years));
const set = (patch: Partial<Filters>) => emit('change', { ...props.filters, ...patch });
const onYear = (e: Event) => set({ year: Number((e.target as HTMLSelectElement).value) || null });
const onSort = (e: Event) => set({ sort: (e.target as HTMLSelectElement).value as Sort });
</script>

<template>
  <div class="toolbar">
    <div v-if="genres.length" class="chips" role="group" aria-label="Género">
      <button class="chip" :aria-pressed="filters.genre === null" @click="set({ genre: null })">Todos</button>
      <button v-for="g in genres" :key="g" class="chip" :aria-pressed="filters.genre === g" @click="set({ genre: filters.genre === g ? null : g })">
        {{ g }}
      </button>
    </div>
    <select v-if="yearOptions.length" class="field" aria-label="Año" :value="filters.year ?? ''" @change="onYear">
      <option value="">Todos los años</option>
      <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}</option>
    </select>
    <select class="field" aria-label="Orden" :value="filters.sort" @change="onSort">
      <option v-for="(label, key) in SORT_LABEL" :key="key" :value="key">Orden: {{ label }}</option>
    </select>
  </div>
</template>
