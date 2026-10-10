<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { activityCount, type Activity } from '../activity.ts';
import { api } from '../api.ts';
import { useDismiss } from '../dismiss.ts';
import { currentProfile, ensureProfile, hasHero } from '../session.ts';
import { theme, toggleTheme } from '../theme.ts';
import type { Suggestion } from '../types.ts';
import { showToast } from '../toast.ts';
import AppActivityPanel from './AppActivityPanel.vue';
import Avatar from './Avatar.vue';
import Icon from './Icon.vue';

const route = useRoute();
const router = useRouter();

const nav: { label: string; to: string; icon: 'home' | 'tv' | 'film' | 'star' | 'bookmark'; exact?: boolean }[] = [
  { label: 'Inicio', to: '/browse', icon: 'home', exact: true },
  { label: 'Series', to: '/browse/series', icon: 'tv' },
  { label: 'Películas', to: '/browse/movies', icon: 'film' },
  { label: 'Anime', to: '/browse/anime', icon: 'star' },
  { label: 'Mi lista', to: '/my-list', icon: 'bookmark' },
];
const isOn = (n: (typeof nav)[number]) => (n.exact ? route.path === n.to : route.path.startsWith(n.to));

const scrolled = ref(false);
const onScroll = () => (scrolled.value = window.scrollY > 24);

// Search
const searchOpen = ref(false);
const q = ref('');
const suggestions = ref<Suggestion[]>([]);
const searchRoot = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
let debounce: ReturnType<typeof setTimeout> | undefined;
let ticket = 0;
useDismiss(searchRoot, () => {
  const was = searchOpen.value;
  closeSearch();
  return was;
});

function closeSearch() {
  searchOpen.value = false;
  suggestions.value = [];
}
async function openSearch() {
  searchOpen.value = true;
  await nextTick();
  input.value?.focus();
}
// On the results page the box shows the current search; that echo must not pop the suggestions open.
const echoed = () => route.path === '/search' && q.value === String(route.query.q ?? '');
watch(
  () => (route.path === '/search' ? String(route.query.q ?? '') : null),
  (shown) => {
    if (shown === null) return;
    q.value = shown;
    searchOpen.value = shown !== '';
  },
  { immediate: true },
);
watch(q, (value) => {
  clearTimeout(debounce);
  const text = value.trim();
  if (!text || echoed()) return void (suggestions.value = []);
  const mine = ++ticket;
  debounce = setTimeout(async () => {
    try {
      const found = await api.suggest(text);
      if (mine === ticket) suggestions.value = found;
    } catch {
      if (mine === ticket) suggestions.value = [];
    }
  }, 200);
});
function submit() {
  const text = q.value.trim();
  if (!text) return;
  closeSearch();
  router.push({ path: '/search', query: { q: text } });
}
function pick(s: Suggestion) {
  closeSearch();
  q.value = '';
  router.push(s.type === 'title' ? `/title/${s.id}` : { path: '/search', query: { q: s.label } });
}

// Profile menu
const menuOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);
useDismiss(menuRoot, () => {
  const was = menuOpen.value;
  menuOpen.value = false;
  return was;
});

// Activity (T32): badge + drawer. Poll only while the drawer is open or there is work.
const panelOpen = ref(false);
const activity = ref<Activity | null>(null);
const activityError = ref(false);
const retrying = ref<number[]>([]);
const activeCount = computed(() => activityCount(activity.value));
let actTimer: ReturnType<typeof setTimeout> | undefined;
let actGen = 0;

async function loadActivity() {
  clearTimeout(actTimer);
  const mine = ++actGen;
  try {
    const next = await api.activity();
    if (mine !== actGen) return;
    activity.value = next;
    activityError.value = false;
  } catch {
    if (mine === actGen) activityError.value = true;
  }
  if (mine === actGen) scheduleActivity();
}
function scheduleActivity() {
  clearTimeout(actTimer);
  if (panelOpen.value || activityCount(activity.value) > 0) actTimer = setTimeout(loadActivity, 5000);
}
watch(panelOpen, (open) => (open ? loadActivity() : scheduleActivity()));

async function retryFile(mediaFileId: number) {
  if (retrying.value.includes(mediaFileId)) return;
  retrying.value = [...retrying.value, mediaFileId];
  try {
    await api.retryFile(mediaFileId);
  } catch {
    showToast('No se pudo reintentar.');
  } finally {
    retrying.value = retrying.value.filter((id) => id !== mediaFileId);
    if (panelOpen.value) loadActivity();
  }
}

onMounted(() => {
  ensureProfile();
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  loadActivity();
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll);
  clearTimeout(debounce);
  clearTimeout(actTimer);
  actGen++;
});
watch(() => route.fullPath, () => (menuOpen.value = false));
</script>

<template>
  <header class="top" :class="{ solid: scrolled || !hasHero }">
    <RouterLink to="/browse" class="logo" aria-label="Inicio">sala</RouterLink>

    <nav class="nav" aria-label="Principal">
      <RouterLink v-for="n in nav" :key="n.to" :to="n.to" :class="{ on: isOn(n) }" :aria-current="isOn(n) ? 'page' : undefined">
        {{ n.label }}
      </RouterLink>
    </nav>

    <button
      class="icon act"
      :class="{ on: panelOpen }"
      :aria-label="activeCount > 0 ? `Actividad, ${activeCount} en curso` : 'Actividad'"
      aria-haspopup="dialog"
      :aria-expanded="panelOpen"
      @pointerdown.stop
      @click="panelOpen = !panelOpen"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 12h4l2.5-7 4 14L16 12h5" />
      </svg>
      <span v-if="activeCount > 0" class="badge" aria-hidden="true">{{ activeCount > 99 ? '99+' : activeCount }}</span>
    </button>

    <div ref="searchRoot" class="search" :class="{ open: searchOpen }">
      <button class="icon" aria-label="Buscar" @click="searchOpen ? closeSearch() : openSearch()">
        <Icon :name="searchOpen ? 'close' : 'search'" />
      </button>
      <input
        v-show="searchOpen"
        ref="input"
        v-model="q"
        type="search"
        placeholder="Títulos, personas…"
        autocomplete="off"
        aria-label="Buscar"
        @keydown.enter="submit"
      />
      <ul v-if="searchOpen && suggestions.length" class="sug" data-suggestions>
        <li v-for="s in suggestions" :key="`${s.type}${s.id}`">
          <button @click="pick(s)">
            <span>{{ s.label }}</span>
            <small>{{ s.type === 'title' ? 'Título' : 'Persona' }}</small>
          </button>
        </li>
      </ul>
    </div>

    <div ref="menuRoot" class="profile">
      <button class="avatar-btn" aria-label="Perfil" aria-haspopup="menu" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
        <Avatar :profile="currentProfile" />
      </button>
      <div v-if="menuOpen" class="menu" role="menu">
        <p class="who">{{ currentProfile?.name ?? '' }}</p>
        <RouterLink role="menuitem" to="/"><Icon name="swap" :size="20" /> Cambiar de perfil</RouterLink>
        <button role="menuitem" @click="toggleTheme(currentProfile?.id ?? null)">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="20" /> {{ theme === 'dark' ? 'Tema claro' : 'Tema oscuro' }}
        </button>
      </div>
    </div>
  </header>

  <nav class="tabbar" aria-label="Secciones">
    <RouterLink v-for="n in nav" :key="n.to" :to="n.to" :class="{ on: isOn(n) }" :aria-current="isOn(n) ? 'page' : undefined">
      <Icon :name="n.icon" :size="24" />
      <span>{{ n.label }}</span>
    </RouterLink>
  </nav>

  <AppActivityPanel
    :open="panelOpen"
    :activity="activity"
    :error="activityError"
    :retrying="retrying"
    @close="panelOpen = false"
    @retry="retryFile"
  />
</template>

<style scoped>
.top {
  position: fixed; inset: 0 0 auto; z-index: 50; display: flex; align-items: center; gap: clamp(12px, 2.4vw, 36px);
  height: var(--header-h); padding: 0 var(--gutter); color: #fff;
  background: linear-gradient(rgba(6, 6, 10, 0.78), transparent); transition: background 0.25s, box-shadow 0.25s;
}
.top.solid { background: var(--header-solid); backdrop-filter: blur(14px); box-shadow: 0 1px 0 var(--line); color: var(--text); }
.logo { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.04em; color: var(--accent); line-height: 1; }
.nav { display: flex; gap: clamp(4px, 1vw, 12px); flex: 1; min-width: 0; }
.nav a { padding: 8px 12px; border-radius: 999px; font-size: 0.95rem; font-weight: 500; opacity: 0.78; white-space: nowrap; transition: opacity 0.15s, background 0.15s; }
.nav a:hover { opacity: 1; background: rgba(128, 128, 150, 0.2); }
.nav a.on { opacity: 1; font-weight: 700; box-shadow: inset 0 -3px 0 var(--accent); border-radius: 6px 6px 0 0; }

.icon, .avatar-btn { display: grid; place-items: center; min-height: 0; padding: 0; background: none; color: inherit; border-radius: 50%; }
.icon { width: 44px; height: 44px; }
.icon:hover { background: rgba(128, 128, 150, 0.25); }
.act { position: relative; }
.act.on { color: var(--accent); }
.badge {
  position: absolute; top: 3px; right: 3px; display: grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: 0.68rem; font-weight: 700; line-height: 1;
  pointer-events: none;
}
.avatar-btn { width: 44px; height: 44px; }
.avatar-btn:hover { background: rgba(128, 128, 150, 0.25); }

.search { position: relative; display: flex; align-items: center; }
.search input {
  width: min(280px, 40vw); min-height: 44px; margin-left: 4px; padding: 0 16px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--bg-raised); color: var(--text);
}
.sug {
  position: absolute; top: 52px; right: 0; width: min(340px, 90vw); margin: 0; padding: 6px; list-style: none;
  background: var(--bg-raised); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); color: var(--text);
}
.sug button { display: flex; justify-content: space-between; gap: 12px; width: 100%; min-height: 0; padding: 11px 14px; border-radius: 8px; background: none; text-align: left; }
.sug button:hover, .sug button:focus-visible { background: var(--bg-hover); }
.sug small { color: var(--text-dim); }

.profile { position: relative; }
.menu {
  position: absolute; top: 54px; right: 0; width: 250px; padding: 8px; background: var(--bg-raised); color: var(--text);
  border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
}
.who { margin: 0; padding: 8px 12px 10px; font-weight: 700; border-bottom: 1px solid var(--line); }
.menu a, .menu button {
  display: flex; align-items: center; gap: 12px; width: 100%; min-height: 0; padding: 12px; margin-top: 4px;
  border-radius: 8px; background: none; text-align: left; font-size: 0.95rem; color: var(--text);
}
.menu a:hover, .menu button:hover, .menu a:focus-visible, .menu button:focus-visible { background: var(--bg-hover); }

.tabbar { display: none; }
.top :focus-visible { outline-offset: 2px; }

@media (max-width: 720px) {
  .top { flex-wrap: wrap; align-content: center; gap: 0 12px; padding-top: 6px; background: linear-gradient(rgba(6, 6, 10, 0.9), rgba(6, 6, 10, 0.4)); }
  .top.solid { background: var(--header-solid); }
  .logo { flex: 1; }
  .nav { order: 3; flex: 0 0 100%; overflow-x: auto; scrollbar-width: none; margin: 0 -6px; padding-bottom: 4px; }
  .nav::-webkit-scrollbar { display: none; }
  .search.open { position: static; }
  .search.open .sug { right: var(--gutter); }
  .search.open input { position: absolute; left: var(--gutter); right: calc(var(--gutter) + 100px); top: 8px; width: auto; }
}
/* Phones: the sections move to a bottom tab bar (thumb reach, nothing clips); the header keeps logo, search and profile. */
@media (max-width: 600px) {
  .top { flex-wrap: nowrap; padding-top: 0; background: linear-gradient(rgba(6, 6, 10, 0.85), transparent); }
  .top.solid { background: var(--header-solid); }
  .nav { display: none; }
  .search.open input { top: 10px; }
  .tabbar {
    position: fixed; inset: auto 0 0; z-index: 50; display: flex; padding-bottom: env(safe-area-inset-bottom);
    background: var(--header-solid); backdrop-filter: blur(14px); box-shadow: 0 -1px 0 var(--line);
  }
  .tabbar a {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    min-height: 60px; padding: 6px 2px; color: var(--text-dim); font-size: 0.68rem; font-weight: 600;
  }
  .tabbar a.on { color: var(--accent); }
  .tabbar :focus-visible { outline-offset: -4px; }
}
</style>
