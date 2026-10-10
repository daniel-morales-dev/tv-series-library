<script setup lang="ts">
import type { FileStatus } from '../fileStatus.ts';
import type { TitleSummary } from '../types.ts';
import TitleCard from './TitleCard.vue';

defineProps<{ titles: TitleSummary[]; statuses?: Map<number, FileStatus> }>();
</script>

<template>
  <ul class="poster-grid">
    <li v-for="t in titles" :key="t.id"><TitleCard :title="t" :status="statuses?.get(t.id)" /></li>
  </ul>
</template>
