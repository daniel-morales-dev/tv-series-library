<script setup lang="ts">
import Hls from 'hls.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, getProfileId, saveProgress, streamUrl } from '../api.ts';
import { isBackKey } from '../spatial.ts';
import { languageName } from '../languages.ts';
import { defaultSubtitle, nextFile, resumePosition, subtitleLabel } from '../player.ts';
import { SPEEDS, loadSpeed, saveSpeed, speedLabel } from '../speed.ts';
import type { MediaFile, SubtitleTrack, TitleDetail } from '../types.ts';
import Icon from '../components/Icon.vue';

const route = useRoute();
const router = useRouter();
const profileId = getProfileId();
const fileId = computed(() => Number(route.params.mediaFileId));
const titleId = computed(() => Number(route.query.title));

const video = ref<HTMLVideoElement>();
const phase = ref<'loading' | 'preparing' | 'playing' | 'error'>('loading');
const message = ref('');
const percent = ref(0);
const detail = ref<TitleDetail | null>(null);
const file = ref<MediaFile | null>(null);
const subs = ref<SubtitleTrack[]>([]);
const subIndex = ref(-1);
const audio = ref<{ id: number; name: string }[]>([]);
const audioIndex = ref(0);
const menu = ref<'tracks' | 'speed' | null>(null);
const speed = ref(loadSpeed());
const idle = ref(false);
const fullscreen = ref(false);
const next = ref<{ fileId: number; name: string } | null>(null);
const countdown = ref(0);

let hls: Hls | undefined;
let run = 0; // bumped on every (re)start so stale async work can bail out
let saveTimer: ReturnType<typeof setInterval> | undefined;
let nextTimer: ReturnType<typeof setInterval> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (text: string) => {
  phase.value = 'error';
  message.value = text;
};

function save() {
  const v = video.value;
  if (!v || !file.value || !profileId || phase.value !== 'playing') return;
  const duration = file.value.durationS ?? v.duration; // v.duration keeps growing while processing
  if (!Number.isFinite(duration) || duration <= 0 || v.currentTime < 1) return;
  saveProgress(profileId, file.value.id, Math.min(v.currentTime, duration), duration);
}

function teardown() {
  save();
  run++;
  clearInterval(saveTimer);
  clearInterval(nextTimer);
  hls?.destroy();
  hls = undefined;
  if (video.value) {
    video.value.removeAttribute('src');
    video.value.load();
  }
  file.value = null;
  next.value = null;
  menu.value = null;
  audio.value = [];
  subs.value = [];
}

async function waitUntilReady(id: number, mine: number) {
  while (run === mine) {
    const res = await fetch(streamUrl(id), { cache: 'no-store' }).catch(() => null);
    if (res?.ok) return true;
    const job = (await api.jobs().catch(() => [])).find((j) => j.mediaFileId === id);
    if (job?.status === 'error') throw new Error(job.error ?? 'error');
    if (job) percent.value = Math.round(job.progress * 100);
    await sleep(2000);
  }
  return false;
}

async function start() {
  teardown();
  const mine = run;
  if (!profileId) return void router.replace('/');
  if (!titleId.value) return void router.replace('/browse');
  phase.value = 'loading';
  try {
    const d = await api.title(titleId.value, profileId);
    const f = d.files.find((x) => x.id === fileId.value);
    if (run !== mine) return;
    if (!f) return fail('No se encontró el archivo.');
    detail.value = d;
    file.value = f;
    subs.value = f.subtitleTracks.filter((t) => t.supported && t.vtt);
    next.value = null;

    const play = await api.play(f.id);
    if (run !== mine) return;
    if (play.status === 'processing') {
      percent.value = 0;
      phase.value = 'preparing';
      if (!(await waitUntilReady(f.id, mine))) return;
    }
    phase.value = 'playing';
    await nextTick();
    if (run !== mine) return;
    attach(f, resumePosition(d.progress, f.id));
    subIndex.value = defaultSubtitle(subs.value);
    applySubtitle();
  } catch (e) {
    if (run === mine) fail(e instanceof Error && e.message !== '404' ? `No se pudo preparar el video (${e.message}).` : 'No se pudo cargar el video.');
  }
}

function attach(f: MediaFile, startAt: number) {
  const v = video.value!;
  const url = streamUrl(f.id);
  if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url;
    v.playbackRate = speed.value;
    if (startAt > 0) v.addEventListener('loadedmetadata', () => (v.currentTime = startAt), { once: true });
    v.play().catch(() => {});
  } else if (Hls.isSupported()) {
    const h = (hls = new Hls({ startPosition: startAt > 0 ? startAt : -1 }));
    h.on(Hls.Events.MANIFEST_PARSED, () => {
      audio.value = h.audioTracks.map((t, i) => ({ id: i, name: t.lang ? languageName(t.lang) : t.name || `Audio ${i + 1}` }));
      audioIndex.value = Math.max(h.audioTrack, 0);
      v.playbackRate = speed.value;
      v.play().catch(() => {}); // autoplay may still be blocked; the user can press play
    });
    h.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
      else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) h.startLoad();
      else fail('Error de reproducción.');
    });
    h.loadSource(url);
    h.attachMedia(v);
  } else {
    fail('Este navegador no puede reproducir el video.');
  }
}

function applySubtitle() {
  const tracks = video.value?.textTracks;
  if (!tracks) return;
  for (let i = 0; i < tracks.length; i++) tracks[i]!.mode = i === subIndex.value ? 'showing' : 'disabled';
}
function pickSubtitle(i: number) {
  subIndex.value = i;
  applySubtitle();
}
function pickSpeed(s: number) {
  speed.value = s;
  if (video.value) video.value.playbackRate = s;
  saveSpeed(s);
  menu.value = null;
}
function toggleMenu(m: 'tracks' | 'speed') {
  menu.value = menu.value === m ? null : m;
}
// Overlay controls fade out after 3 s without input while playing; any movement or key brings them back.
function poke() {
  idle.value = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (video.value && !video.value.paused && !menu.value && !next.value) idle.value = true;
  }, 3000);
}
function togglePlay() {
  const v = video.value;
  if (v) v.paused ? v.play().catch(() => {}) : v.pause();
}
function onVideoClick() {
  if (menu.value) menu.value = null;
  else togglePlay();
}
function pickAudio(i: number) {
  if (hls) hls.audioTrack = i;
  audioIndex.value = i;
}

const onPlay = () => {
  clearInterval(saveTimer);
  saveTimer = setInterval(save, 10_000);
  poke();
};
const onPause = () => {
  clearInterval(saveTimer);
  save();
  poke();
};
function onEnded() {
  onPause();
  const n = detail.value && file.value ? nextFile(detail.value, file.value.id) : null;
  if (!n) return;
  next.value = n;
  countdown.value = 10;
  nextTimer = setInterval(() => {
    if (--countdown.value <= 0) goNext();
  }, 1000);
}
function cancelNext() {
  clearInterval(nextTimer);
  next.value = null;
}
function goNext() {
  const n = next.value;
  if (!n) return;
  clearInterval(nextTimer);
  router.replace({ path: `/watch/${n.fileId}`, query: { title: titleId.value } });
}
const back = () => router.push(`/title/${titleId.value}`);

// Fullscreen the container, not the <video>, so the menus and the next-episode prompt stay visible.
const root = ref<HTMLElement>();
const syncFullscreen = () => (fullscreen.value = !!document.fullscreenElement);
function toggleFullscreen() {
  if (document.fullscreenElement) return void document.exitFullscreen();
  if (root.value?.requestFullscreen) return void root.value.requestFullscreen().catch(() => {});
  (video.value as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.(); // iOS Safari
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  const onButton = t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement;
  const v = video.value;
  if (inField || !v) return;
  poke();
  if (e.key === 'Escape' && menu.value) {
    menu.value = null;
  } else if (isBackKey(e)) {
    back();
  } else if ((e.key === ' ' || e.key === 'Enter') && !onButton) {
    togglePlay();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !menu.value) {
    v.currentTime = Math.max(0, v.currentTime + (e.key === 'ArrowLeft' ? -10 : 10));
  } else {
    return;
  }
  e.preventDefault();
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', save);
  document.addEventListener('fullscreenchange', syncFullscreen);
  poke();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('pagehide', save);
  document.removeEventListener('fullscreenchange', syncFullscreen);
  clearTimeout(idleTimer);
  teardown();
});
watch([fileId, titleId], start, { immediate: true });
</script>

<template>
  <div ref="root" class="watch" :class="{ idle }" @mousemove="poke" @pointerdown="poke" @touchstart.passive="poke">
    <video
      ref="video"
      v-show="phase === 'playing'"
      controls
      controlslist="nofullscreen"
      playsinline
      @click="onVideoClick"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
    >
      <track
        v-for="(t, i) in subs"
        :key="`${fileId}-${t.index}`"
        kind="subtitles"
        :src="streamUrl(fileId, t.vtt!)"
        :srclang="t.language ?? undefined"
        :label="subtitleLabel(t, i)"
      />
    </video>

    <RouterLink class="btn top left chrome" :to="`/title/${titleId || ''}`">← Volver</RouterLink>

    <p v-if="phase === 'loading'" class="center muted">Cargando…</p>
    <p v-else-if="phase === 'preparing'" class="center">Preparando… {{ percent }} %</p>
    <p v-else-if="phase === 'error'" class="center error">{{ message }}</p>

    <template v-if="phase === 'playing'">
      <div class="top right actions chrome">
        <button class="round speed" :class="{ on: menu === 'speed' }" aria-label="Velocidad de reproducción" title="Velocidad de reproducción" aria-haspopup="menu" :aria-expanded="menu === 'speed'" @click="toggleMenu('speed')">
          {{ speedLabel(speed) }}
        </button>
        <button class="round" :class="{ on: menu === 'tracks' }" aria-label="Audio y subtítulos" title="Audio y subtítulos" aria-haspopup="menu" :aria-expanded="menu === 'tracks'" @click="toggleMenu('tracks')">
          <Icon name="captions" :size="26" />
        </button>
        <button class="round" :aria-label="fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'" :title="fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'" @click="toggleFullscreen">
          <Icon :name="fullscreen ? 'fullscreenExit' : 'fullscreen'" :size="26" />
        </button>
      </div>
      <div v-if="menu === 'tracks'" class="menu" role="menu">
        <template v-if="audio.length > 1">
          <h2>Audio</h2>
          <button v-for="a in audio" :key="a.id" role="menuitemradio" :aria-checked="a.id === audioIndex" :class="{ on: a.id === audioIndex }" @click="pickAudio(a.id)">{{ a.name }}</button>
        </template>
        <h2>Subtítulos</h2>
        <button role="menuitemradio" :aria-checked="subIndex === -1" :class="{ on: subIndex === -1 }" @click="pickSubtitle(-1)">Sin subtítulos</button>
        <button v-for="(t, i) in subs" :key="t.index" role="menuitemradio" :aria-checked="subIndex === i" :class="{ on: subIndex === i }" @click="pickSubtitle(i)">{{ subtitleLabel(t, i) }}</button>
      </div>
      <div v-else-if="menu === 'speed'" class="menu" role="menu">
        <h2>Velocidad</h2>
        <button v-for="s in SPEEDS" :key="s" role="menuitemradio" :aria-checked="s === speed" :class="{ on: s === speed }" @click="pickSpeed(s)">{{ speedLabel(s) }}</button>
      </div>
    </template>

    <div v-if="next" class="next">
      <p>Siguiente: {{ next.name }} en {{ countdown }} s</p>
      <button @click="goNext">Ver ahora</button>
      <button @click="cancelNext">Cancelar</button>
    </div>
  </div>
</template>

<style scoped>
.watch { position: fixed; inset: 0; background: #000; }
video { width: 100%; height: 100%; background: #000; }
.top { position: absolute; top: 12px; z-index: 2; background: rgba(0, 0, 0, 0.6); }
.left { left: 12px; }
.right { right: 12px; }
.actions { display: flex; gap: 10px; background: none; }
.round.speed { width: auto; min-width: 44px; padding: 0 12px; border-radius: 999px; font-weight: 700; font-size: 0.95rem; }
.chrome { transition: opacity 0.25s; }
.idle { cursor: none; }
.idle .chrome { opacity: 0; pointer-events: none; }
.center { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; text-align: center; padding: 0 16px; }
.menu {
  position: absolute; top: 68px; right: 12px; z-index: 2; display: flex; flex-direction: column; gap: 8px; min-width: 180px;
  max-height: calc(100% - 100px); overflow: auto; padding: 12px; border-radius: 12px; background: rgba(15, 15, 18, 0.95);
}
.menu h2 { margin: 8px 0 0; font-size: 1rem; color: var(--text-dim); }
.menu button { min-height: 44px; text-align: left; }
.menu .on { background: var(--accent); color: var(--accent-ink); }
.next {
  position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 2; display: flex; gap: 12px;
  align-items: center; flex-wrap: wrap; justify-content: center; padding: 12px 20px; border-radius: 12px; background: rgba(15, 15, 18, 0.95);
}
.next p { margin: 0; }
</style>
