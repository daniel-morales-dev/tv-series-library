<script setup lang="ts">
import type { TitleSummary } from '../types.ts';
import TitleCard from './TitleCard.vue';

defineProps<{ titles: TitleSummary[] }>();
</script>

<template>
  <ul class="poster-grid">
    <li v-for="t in titles" :key="t.id"><TitleCard :title="t" /></li>
  </ul>
</template>
