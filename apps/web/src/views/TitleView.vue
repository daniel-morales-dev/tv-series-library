<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, getProfileId, imageUrl } from '../api.ts';
import EpisodePanel from '../components/EpisodePanel.vue';
import ExtraCard from '../components/ExtraCard.vue';
import Icon from '../components/Icon.vue';
import LangLine from '../components/LangLine.vue';
import { franchiseEntries } from '../franchise.ts';
import { fileStatus, movieStatus, needsPolling } from '../fileStatus.ts';
import { fileLanguages, titleLanguages } from '../languages.ts';
import { KIND_LABEL, initial, progressPct, remainingLabel, unavailableNotice } from '../library.ts';
import { hasHero, inMyList, loadMyList, toggleMyList } from '../session.ts';
import { airDateLabel, buildEpisodes, castOf, episodeAction, isPlayable, playPlan, runtimeLabel, seasonFinished, seenToggle, type EpisodeRow } from '../titlePage.ts';
import type { Job, MediaFile, TitleDetail } from '../types.ts';

const route = useRoute();
const router = useRouter();
const detail = ref<Awaited<ReturnType<typeof api.title>> | null>(null);
const jobs = ref<Job[]>([]);
const error = ref('');
const seasonNumber = ref<number | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let gen = 0;

async function load() {
  clearTimeout(timer);
  const mine = ++gen;
  try {
    const [d, j] = await Promise.all([api.title(Number(route.params.id), getProfileId() ?? 0), api.jobs()]);
    if (mine !== gen) return;
    detail.value = d;
    jobs.value = j;
    error.value = '';
  } catch {
    if (mine === gen) error.value = 'No se pudo cargar el título.';
  }
  if (mine === gen && detail.value && needsPolling(detail.value.files)) timer = setTimeout(load, 5000);
}

onMounted(() => {
  hasHero.value = true;
  load();
  loadMyList().catch(() => {});
});
onBeforeUnmount(() => {
  hasHero.value = false;
  gen++;
  clearTimeout(timer);
});
watch(() => route.params.id, () => {
  detail.value = null;
  seasonNumber.value = null;
  refreshMsg.value = null;
  load();
});

const seasons = computed(() => (detail.value ? buildEpisodes(detail.value) : []));
const allRows = computed(() => seasons.value.flatMap((s) => s.rows));
const plan = computed(() => (detail.value ? playPlan(detail.value) : null));
const episodeId = computed(() => Number(route.query.episode) || null);
const openRow = computed(() => allRows.value.find((r) => r.id === episodeId.value) ?? null);

// Season shown: the user's pick, else the one holding the deep-linked or next-to-watch episode.
const season = computed(() => {
  const byPick = seasons.value.find((s) => s.number === seasonNumber.value);
  if (byPick) return byPick;
  const target = openRow.value ?? allRows.value.find((r) => r.file?.id === plan.value?.fileId);
  return seasons.value.find((s) => s.number === target?.season) ?? seasons.value[0] ?? null;
});

const status = (f: MediaFile | null) => (f ? fileStatus(f, jobs.value) : null);
// A film's single main file status, shown next to the play button: en cola / procesando N % / listo / error / sin archivo.
const film = computed(() => (detail.value?.kind === 'movie' ? movieStatus(detail.value.files, jobs.value) : null));
const unavailable = computed(() => (detail.value ? unavailableNotice(detail.value.available) : null));
const extras = computed(() => detail.value?.files.filter((f) => f.extraLabel) ?? []);
const cast = computed(() => (detail.value ? castOf(detail.value.credits) : []));
const langs = computed(() => (detail.value ? titleLanguages(detail.value.files) : { audio: [], subs: [] }));
const listed = computed(() => (detail.value ? inMyList(detail.value.id) : false));
const related = computed(() => (detail.value?.franchise ? franchiseEntries(detail.value.franchise.items) : []));
const epCount = computed(() => allRows.value.length);

const meta = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const count =
    d.kind === 'movie'
      ? runtimeLabel(d.runtimeMin, null)
      : seasons.value.length
        ? `${seasons.value.length} ${seasons.value.length === 1 ? 'temporada' : 'temporadas'} · ${epCount.value} ${epCount.value === 1 ? 'episodio' : 'episodios'}`
        : null;
  return [KIND_LABEL[d.kind], d.year, ...d.genres.slice(0, 2), d.rating ? `★ ${d.rating.toFixed(1).replace('.', ',')}` : null, count].filter(Boolean) as (string | number)[];
});

const watchTo = (fileId: number) => ({ path: `/watch/${fileId}`, query: { title: detail.value!.id } });
const stillOf = (r: EpisodeRow) => r.stillPath ?? detail.value?.backdropPath ?? null;

const busy = ref(false);
async function toggleFinished() {
  const pid = getProfileId();
  if (!pid || !detail.value || busy.value) return;
  busy.value = true;
  try {
    await api.setFinished(pid, detail.value.id, !detail.value.finished);
    await load();
  } finally {
    busy.value = false;
  }
}

// T52: explicit on-demand TMDB refresh; the only action that re-queries TMDB for an existing title.
const refreshing = ref(false);
const refreshMsg = ref<{ ok: boolean; text: string } | null>(null);
async function refreshMetadata() {
  if (!detail.value || refreshing.value) return;
  refreshing.value = true;
  refreshMsg.value = null;
  try {
    await api.refreshMetadata(detail.value.id);
    refreshMsg.value = { ok: true, text: 'Metadata actualizada.' };
    await load();
  } catch (err) {
    refreshMsg.value = { ok: false, text: err instanceof Error ? err.message : 'No se pudo actualizar la metadata.' };
  } finally {
    refreshing.value = false;
  }
}

async function toggleEpisodeSeen(r: EpisodeRow) {
  const pid = getProfileId();
  const t = seenToggle(r);
  if (!pid || !t || busy.value) return;
  busy.value = true;
  try {
    await api.setFileFinished(pid, t.fileId, t.finished);
    await load();
  } finally {
    busy.value = false;
  }
}

const seasonDone = computed(() => (season.value ? seasonFinished(season.value) : false));
async function toggleSeasonFinished() {
  const pid = getProfileId();
  if (!pid || !detail.value || !season.value || busy.value) return;
  busy.value = true;
  try {
    await api.setSeasonFinished(pid, detail.value.id, season.value.number, !seasonDone.value);
    await load();
  } finally {
    busy.value = false;
  }
}

// Episode panel: opened via ?episode=<id>; focus returns to the row that opened it.
let opener: HTMLElement | null = null;
function openEpisode(r: EpisodeRow, ev?: Event) {
  opener = (ev?.currentTarget as HTMLElement) ?? null;
  router.replace({ query: { ...route.query, episode: r.id } });
}
async function closeEpisode() {
  const id = episodeId.value;
  const { episode: _drop, ...rest } = route.query;
  await router.replace({ query: rest });
  await nextTick();
  (opener ?? document.querySelector<HTMLElement>(`[data-ep="${id}"]`))?.focus();
  opener = null;
}
</script>

<template>
  <main v-if="error" class="page state"><h2>No se pudo cargar</h2><p>{{ error }}</p><RouterLink class="pill" to="/browse">Volver al inicio</RouterLink></main>
  <div v-else-if="!detail" class="skeleton" aria-busy="true" />
  <template v-else>
    <section class="hero">
      <img v-if="detail.backdropPath" class="bg" :src="imageUrl(detail.backdropPath)" alt="" fetchpriority="high" draggable="false" />
      <div class="copy">
        <img v-if="detail.logoPath" class="logo" :src="imageUrl(detail.logoPath)" :alt="detail.title" />
        <h1 v-else class="name">{{ detail.title }}</h1>
        <span v-if="detail.comingSoon" class="soon">Próximamente</span>
        <ul class="meta">
          <li v-for="m in meta" :key="m">{{ m }}</li>
        </ul>
        <LangLine :langs="langs" class="hero-langs" />
        <p v-if="detail.overview" class="overview">{{ detail.overview }}</p>
        <div class="btns">
          <RouterLink v-if="plan" class="pill primary" data-autofocus :to="watchTo(plan.fileId)"><Icon name="play" /> {{ plan.label }}</RouterLink>
          <button
            class="round"
            data-autofocus
            :class="{ on: listed }"
            :aria-label="listed ? 'Quitar de Mi lista' : 'Agregar a Mi lista'"
            :aria-pressed="listed"
            :title="listed ? 'En Mi lista' : 'Mi lista'"
            @click="toggleMyList(detail)"
          >
            <Icon :name="listed ? 'check' : 'plus'" />
          </button>
          <span v-if="film" class="badge" :class="film.kind" :title="film.detail">{{ film.label }}</span>
          <span v-if="unavailable" class="badge off">{{ unavailable.label }} · {{ unavailable.hint }}</span>
          <span v-if="detail.comingSoon && !film" class="muted">Se está descargando</span>
          <button class="pill glass" :disabled="busy" :aria-pressed="!!detail.finished" @click="toggleFinished">
            <Icon :name="detail.finished ? 'close' : 'check'" :size="20" /> {{ detail.finished ? 'No visto' : 'Marcar como visto' }}
          </button>
          <button class="pill glass" :disabled="refreshing" @click="refreshMetadata">
            {{ refreshing ? 'Refrescando…' : 'Refrescar metadata' }}
          </button>
          <span v-if="refreshMsg" class="refresh-msg" :class="{ bad: !refreshMsg.ok }" role="status">{{ refreshMsg.text }}</span>
        </div>
      </div>
    </section>

    <div class="content">
      <section v-if="season" class="eps" aria-labelledby="eps-h">
        <div class="eps-head">
          <h2 id="eps-h">{{ detail.kind === 'movie' ? 'Película' : 'Episodios' }}</h2>
          <div v-if="seasons.length > 1" class="tabs" role="tablist" aria-label="Temporadas">
            <button
              v-for="s in seasons"
              :key="s.id"
              role="tab"
              :aria-selected="s.id === season.id"
              :class="{ on: s.id === season.id }"
              @click="seasonNumber = s.number"
            >
              {{ s.name || `Temporada ${s.number}` }}
            </button>
          </div>
          <p v-else-if="season.name" class="muted season-name">{{ season.name }} · {{ season.rows.length }} episodios</p>
          <button v-if="detail.kind !== 'movie'" class="pill soft season-seen" :disabled="busy" :aria-pressed="seasonDone" @click="toggleSeasonFinished">
            <Icon :name="seasonDone ? 'close' : 'check'" :size="20" /> {{ seasonDone ? 'Marcar temporada como no vista' : 'Marcar temporada como vista' }}
          </button>
        </div>

        <ol class="list">
          <li v-for="r in season.rows" :key="r.id" class="row" :class="{ off: !isPlayable(r.file) }">
            <component
              :is="isPlayable(r.file) ? 'RouterLink' : 'div'"
              class="thumb"
              v-bind="isPlayable(r.file) ? { to: watchTo(r.file.id), 'aria-label': `Reproducir episodio ${r.number}` } : {}"
            >
              <img v-if="stillOf(r)" :src="imageUrl(stillOf(r)!)" alt="" loading="lazy" draggable="false" />
              <span v-if="isPlayable(r.file)" class="play"><Icon name="play" :size="30" /></span>
              <span v-if="r.progress?.completed" class="seen">Visto</span>
              <span v-else-if="episodeAction(r) === 'resume'" class="bar">
                <i :style="{ width: `${progressPct(r.progress!.positionS, r.progress!.durationS)}%` }" />
              </span>
            </component>
            <button class="info" :data-ep="r.id" :aria-label="`Ver información del episodio ${r.number}`" @click="openEpisode(r, $event)">
              <span class="head">
                <span class="title"><b>E{{ r.number }}</b> {{ r.name || `Episodio ${r.number}` }}</span>
                <span class="when">{{ [runtimeLabel(r.runtimeMin, r.file?.durationS ?? null), airDateLabel(r.airDate)].filter(Boolean).join(' · ') }}</span>
              </span>
              <span v-if="r.overview" class="syn">{{ r.overview }}</span>
              <span class="foot">
                <LangLine v-if="r.file" :langs="fileLanguages(r.file)" class="muted" />
                <span v-if="status(r.file)" class="badge" :class="status(r.file)!.kind">{{ status(r.file)!.label }}</span>
                <span v-else class="badge queued">sin archivo</span>
                <span v-if="episodeAction(r) === 'resume'" class="muted left">{{ remainingLabel(r.progress!.positionS, r.progress!.durationS) }}</span>
              </span>
            </button>
            <button
              v-if="seenToggle(r)"
              class="seen-btn"
              :class="{ on: r.progress?.completed }"
              :disabled="busy"
              :aria-pressed="!!r.progress?.completed"
              :aria-label="`${seenToggle(r)!.label}: episodio ${r.number}`"
              :title="seenToggle(r)!.label"
              @click="toggleEpisodeSeen(r)"
            >
              <Icon name="check" :size="20" /><span>{{ r.progress?.completed ? 'Visto' : 'Marcar visto' }}</span>
            </button>
          </li>
        </ol>
      </section>

      <section v-if="extras.length" aria-labelledby="ex-h">
        <h2 id="ex-h">Extras</h2>
        <ul class="extras">
          <li v-for="f in extras" :key="f.id">
            <ExtraCard :file="f" :status="status(f)!" :to="watchTo(f.id)" />
          </li>
        </ul>
      </section>

      <section v-if="related.length" aria-labelledby="rel-h">
        <h2 id="rel-h">Relacionados <span class="muted fr-name">{{ detail.franchise!.name }}</span></h2>
        <ol class="related">
          <li v-for="e in related" :key="e.id" :class="{ cur: e.relation === 'Actual' }">
            <component :is="e.relation === 'Actual' ? 'div' : 'RouterLink'" class="rel-card" v-bind="e.relation === 'Actual' ? { 'aria-current': 'true' } : { to: `/title/${e.id}` }">
              <span class="rel-poster">
                <img v-if="e.posterPath" :src="imageUrl(e.posterPath)" :alt="e.name" loading="lazy" draggable="false" />
                <template v-else>{{ initial(e.name) }}</template>
              </span>
              <span class="rel-rel">{{ e.relation }}</span>
              <span class="rel-name">{{ e.name }}</span>
              <span class="rel-sub">{{ [e.typeLabel, e.year].filter(Boolean).join(' · ') }}</span>
            </component>
          </li>
        </ol>
      </section>

      <section v-if="cast.length" aria-labelledby="cast-h">
        <h2 id="cast-h">Reparto</h2>
        <ul class="cast">
          <li v-for="c in cast" :key="c.personId">
            <span class="face">
              <img v-if="c.profilePath" :src="imageUrl(c.profilePath)" alt="" loading="lazy" draggable="false" />
              <template v-else>{{ initial(c.name) }}</template>
            </span>
            <span class="c-name">{{ c.name }}</span>
            <span v-if="c.character" class="c-role">{{ c.character }}</span>
          </li>
        </ul>
      </section>
    </div>

    <EpisodePanel
      v-if="openRow"
      :row="openRow"
      :status="status(openRow.file)"
      :title-id="detail.id"
      :fallback="detail.backdropPath"
      @close="closeEpisode"
      @toggle-seen="toggleEpisodeSeen(openRow)"
    />
  </template>
</template>

<style scoped>
.skeleton { height: clamp(420px, 62vh, 680px); background: linear-gradient(100deg, var(--bg-raised) 30%, var(--bg-card) 50%, var(--bg-raised) 70%) 0 0 / 300% 100%; animation: shimmer 1.4s linear infinite; }
@keyframes shimmer { to { background-position: -300% 0; } }
.hero { position: relative; height: clamp(440px, 64vh, 700px); overflow: hidden; background: #000; color: #fff; }
.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 20%; }
.hero::before, .hero::after { content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.hero::before { background: linear-gradient(90deg, rgba(6, 6, 10, 0.9) 0%, rgba(6, 6, 10, 0.55) 40%, transparent 72%); }
.hero::after { background: linear-gradient(transparent 80%, var(--bg) 100%), linear-gradient(rgba(6, 6, 10, 0.55), transparent 22%); }
.copy {
  position: absolute; z-index: 2; left: var(--gutter); bottom: clamp(40px, 9vh, 90px);
  width: min(660px, calc(100% - 2 * var(--gutter))); display: flex; flex-direction: column; align-items: flex-start; gap: 12px;
}
/* Dark scrim behind the text: the hero stays dark in both themes, so the copy never sits on the light page. */
.copy::before { content: ''; position: absolute; z-index: -1; inset: -40px -56px -32px calc(-1 * var(--gutter)); background: linear-gradient(90deg, rgba(6, 6, 10, 0.85) 0%, rgba(6, 6, 10, 0) 100%); pointer-events: none; }
.logo { max-width: min(420px, 80%); max-height: 140px; object-fit: contain; object-position: left bottom; filter: drop-shadow(0 4px 18px rgba(0, 0, 0, 0.6)); }
.name { margin: 0; font-size: clamp(2.2rem, 5vw, 3.8rem); line-height: 1.02; letter-spacing: -0.02em; text-shadow: 0 4px 24px rgba(0, 0, 0, 0.6); }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin: 0; padding: 0; list-style: none; font-size: 0.95rem; font-weight: 600; color: #e6e6f0; }
.meta li + li::before { content: ''; display: inline-block; width: 4px; height: 4px; margin-right: 14px; vertical-align: middle; border-radius: 50%; background: var(--accent); }
.hero-langs { color: #dcdce8; }
.overview {
  margin: 0; max-width: 60ch; font-size: clamp(0.95rem, 1.2vw, 1.05rem); line-height: 1.5; color: #e9e9f2;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
}
.btns { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 6px; }
.pill:disabled { opacity: 0.6; cursor: default; }
.refresh-msg { font-size: 0.85rem; color: var(--text-dim); }
.refresh-msg.bad { color: var(--danger); }

.content { position: relative; z-index: 2; padding: 0 var(--gutter) 80px; max-width: 1500px; margin: 0 auto; }
section { margin-top: 26px; }
h2 { margin: 0 0 14px; font-size: 1.35rem; letter-spacing: -0.01em; }
.eps-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 22px; margin-bottom: 14px; }
.eps-head h2 { margin: 0; }
.season-name { margin: 0; }
.season-seen { margin-left: auto; }
.tabs { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; max-width: 100%; }
.tabs button { min-height: 40px; padding: 0 16px; border-radius: 999px; font-weight: 600; white-space: nowrap; background: var(--bg-card); color: var(--text-dim); }
.tabs button.on { background: var(--accent); color: var(--accent-ink); }

.list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.row { display: grid; grid-template-columns: clamp(150px, 20vw, 260px) 1fr auto; gap: clamp(12px, 2vw, 24px); align-items: start; padding: 14px 0; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.seen-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 14px; border-radius: 999px; font-size: 0.85rem; font-weight: 600; white-space: nowrap; background: var(--bg-card); color: var(--text-dim); }
.seen-btn.on { background: var(--accent); color: var(--accent-ink); }
.seen-btn:disabled { opacity: 0.6; cursor: default; }
.thumb { position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 10px; background: linear-gradient(160deg, var(--bg-hover), var(--bg-card)); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.row.off .thumb img { opacity: 0.45; }
.play { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; background: rgba(8, 8, 12, 0.45); opacity: 0; transition: opacity 0.15s; }
.play :deep(svg) { padding: 10px; box-sizing: content-box; border-radius: 50%; border: 2px solid #fff; }
.thumb:hover .play, .thumb:focus-visible .play { opacity: 1; }
.seen { position: absolute; left: 8px; top: 8px; padding: 2px 9px; border-radius: 6px; background: var(--accent); color: var(--accent-ink); font-size: 0.75rem; font-weight: 700; }
.bar { position: absolute; inset: auto 0 0; height: 5px; background: var(--track); }
.bar i { display: block; height: 100%; background: var(--accent); }
.info { display: flex; flex-direction: column; align-items: stretch; gap: 6px; min-height: 0; padding: 4px 8px; margin: -4px -8px; border-radius: 10px; background: none; text-align: left; }
.info:hover { background: var(--bg-card); }
.head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 16px; }
.title { font-size: 1.05rem; font-weight: 600; }
.title b { color: var(--accent); margin-right: 4px; }
.when { color: var(--text-dim); font-size: 0.88rem; }
.syn { color: var(--text-dim); font-size: 0.92rem; line-height: 1.5; max-width: 80ch; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.left { font-size: 0.85rem; }
.badge { display: inline-flex; align-items: center; min-height: 0; height: 1.7em; padding: 0 0.85em; white-space: nowrap; line-height: 1; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: var(--bg-hover); color: var(--text-dim); }
.badge.ready { color: var(--ok); }
.badge.processing, .badge.downloading { color: var(--warn); }
.badge.error { color: var(--err); }
.badge.off { color: var(--err); }

.fr-name { margin-left: 8px; font-size: 0.95rem; font-weight: 500; }
.related { margin: 0; padding: 0 0 6px; list-style: none; display: flex; gap: 16px; overflow-x: auto; scrollbar-width: thin; }
.related li { flex: none; width: 140px; }
.rel-card { display: flex; flex-direction: column; gap: 3px; padding: 6px; border-radius: 12px; }
a.rel-card:hover { background: var(--bg-card); }
.cur .rel-card { outline: 2px solid var(--accent); }
.rel-poster { display: grid; place-items: center; aspect-ratio: 2 / 3; overflow: hidden; border-radius: 8px; background: var(--bg-hover); font-size: 2rem; font-weight: 700; color: var(--text-dim); }
.rel-poster img { width: 100%; height: 100%; object-fit: cover; }
.rel-rel { margin-top: 4px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); }
.rel-name { font-size: 0.9rem; font-weight: 600; line-height: 1.25; }
.rel-sub { font-size: 0.78rem; color: var(--text-dim); }

.extras { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }

.cast { margin: 0; padding: 0 0 6px; list-style: none; display: flex; gap: 20px; overflow-x: auto; scrollbar-width: thin; }
.cast li { flex: none; width: 110px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2px; }
.face { position: relative; display: grid; place-items: center; width: 92px; height: 92px; margin-bottom: 6px; overflow: hidden; border-radius: 50%; background: var(--bg-hover); font-size: 2rem; font-weight: 700; color: var(--text-dim); }
.face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center top; }
.c-name { font-size: 0.88rem; font-weight: 600; line-height: 1.25; }
.c-role { font-size: 0.78rem; color: var(--text-dim); line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

@media (max-width: 720px) {
  .hero { height: clamp(460px, 72vh, 620px); }
  .hero::before { background: linear-gradient(90deg, rgba(6, 6, 10, 0.7), rgba(6, 6, 10, 0.2)); }
  .copy { bottom: 28px; gap: 10px; }
  .row { grid-template-columns: 116px 1fr; gap: 12px; }
  .seen-btn { grid-column: 2; justify-self: start; }
  .syn { -webkit-line-clamp: 3; font-size: 0.86rem; }
  .play { display: none; }
}
</style>
