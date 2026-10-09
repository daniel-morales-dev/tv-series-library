<script setup lang="ts">
import type { Languages } from '../languages.ts';

defineProps<{ langs: Languages }>();
</script>

<template>
  <p v-if="langs.audio.length || langs.subs.length" class="langs">
    <span v-if="langs.audio.length"><b>Audio:</b> {{ langs.audio.join(', ') }}</span>
    <span v-if="langs.subs.length"><b>Subtítulos:</b> {{ langs.subs.join(', ') }}</span>
  </p>
</template>

<style scoped>
.langs { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 0; font-size: 0.85rem; color: inherit; opacity: 0.85; }
.langs b { font-weight: 600; opacity: 0.8; }
</style>
