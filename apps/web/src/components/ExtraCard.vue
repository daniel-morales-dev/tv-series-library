<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router';
import type { FileStatus } from '../fileStatus.ts';
import { isPlayable, runtimeLabel } from '../titlePage.ts';
import type { MediaFile } from '../types.ts';
import Icon from './Icon.vue';

const props = defineProps<{ file: MediaFile; status: FileStatus; to: RouteLocationRaw }>();
const playable = isPlayable(props.file);
</script>

<template>
  <component :is="playable ? 'RouterLink' : 'div'" class="extra" :class="{ playable }" v-bind="playable ? { to } : {}">
    <Icon v-if="playable" name="play" :size="22" />
    <span class="x-name">{{ file.extraLabel }}</span>
    <span class="x-sub">{{ runtimeLabel(null, file.durationS) ?? '' }}</span>
    <span class="badge" :class="status.kind">{{ status.label }}</span>
  </component>
</template>

<style scoped>
.extra { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 2px 10px; padding: 10px 14px; border-radius: 12px; background: var(--bg-card); }
.extra:hover { background: var(--bg-hover); }
.extra > svg { grid-row: span 2; color: var(--accent); }
.x-name { grid-column: 1 / -1; font-weight: 600; overflow-wrap: anywhere; }
.x-sub { grid-column: 1 / -1; font-size: 0.8rem; color: var(--text-dim); }
.playable .x-name, .playable .x-sub { grid-column: 2; }
.badge { grid-column: 1 / -1; justify-self: start; margin-top: 4px; display: inline-flex; align-items: center; height: 1.7em; padding: 0 0.85em; white-space: nowrap; line-height: 1; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: var(--bg-hover); color: var(--text-dim); }
.badge.ready { color: #4cc38a; }
.badge.processing, .badge.downloading { color: #e8b84a; }
.badge.error { color: var(--danger); }
</style>
