<script setup lang="ts">
import { avatarColor, initial } from '../library.ts';
import type { Profile } from '../types.ts';

defineProps<{ profile: Pick<Profile, 'id' | 'name' | 'avatar'> | null }>();
</script>

<template>
  <span class="avatar" :style="{ background: profile ? avatarColor(profile) : 'var(--bg-hover)' }" aria-hidden="true">
    {{ profile ? initial(profile.name) : '' }}
  </span>
</template>

<style scoped>
.avatar {
  display: inline-grid; place-items: center; width: var(--size, 36px); height: var(--size, 36px);
  border-radius: 22%; color: #fff; font-weight: 700; font-size: calc(var(--size, 36px) * 0.46);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35); user-select: none;
}
</style>
