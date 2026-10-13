<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api.ts';
import { candidateLabel, fileName, parsedLabel, pendingErrorLabel, pendingReasonLabel, type ConfirmChoice, type PendingItem } from '../pending.ts';

const items = ref<PendingItem[] | null>(null);
const failed = ref(false);
const picks = ref<Record<number, string>>({});
const manualType = ref<Record<number, 'tv' | 'movie'>>({});
const manualId = ref<Record<number, string>>({});
const rowState = ref<Record<number, { kind: 'busy' | 'ok' | 'error'; text: string }>>({});

async function load() {
  try {
    items.value = await api.pending();
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

// A row with candidates confirms one of them; a row without any needs a TMDB id typed in by hand.
function choice(p: PendingItem): ConfirmChoice | null {
  if (p.candidates.length) {
    const picked = p.candidates.find((c) => `${c.tmdbType}:${c.tmdbId}` === picks.value[p.id]);
    return picked ? { tmdbType: picked.tmdbType, tmdbId: picked.tmdbId } : null;
  }
  const id = Number(manualId.value[p.id] ?? '');
  return Number.isInteger(id) && id > 0 ? { tmdbType: manualType.value[p.id] ?? 'tv', tmdbId: id } : null;
}

const stateOf = (id: number) => rowState.value[id] ?? null;

async function confirmRow(p: PendingItem) {
  const pick = choice(p);
  if (!pick || stateOf(p.id)?.kind === 'busy') return;
  rowState.value = { ...rowState.value, [p.id]: { kind: 'busy', text: 'Confirmando…' } };
  try {
    const result = await api.confirmPending(p.id, pick);
    const files = result.placed === 1 ? 'archivo ubicado' : 'archivos ubicados';
    rowState.value = { ...rowState.value, [p.id]: { kind: 'ok', text: `Confirmado · ${result.placed} ${files}` } };
  } catch (err) {
    rowState.value = { ...rowState.value, [p.id]: { kind: 'error', text: pendingErrorLabel(err) } };
  }
}

async function ignoreRow(p: PendingItem) {
  if (stateOf(p.id)?.kind === 'busy') return;
  rowState.value = { ...rowState.value, [p.id]: { kind: 'busy', text: 'Ignorando…' } };
  try {
    await api.ignorePending(p.id);
    rowState.value = { ...rowState.value, [p.id]: { kind: 'ok', text: 'Ignorado.' } };
  } catch (err) {
    rowState.value = { ...rowState.value, [p.id]: { kind: 'error', text: pendingErrorLabel(err) } };
  }
}

onMounted(load);
</script>

<template>
  <main class="pending">
    <h1>Pendientes</h1>
    <p class="help">
      Archivos que la biblioteca no pudo ubicar sola. Confirma a qué título de TMDB pertenecen (sus archivos vecinos se ubican
      también) o ignóralos para que dejen de aparecer.
    </p>
    <p v-if="failed" role="alert">No se pudo cargar la lista de pendientes.</p>
    <template v-else-if="items">
      <p v-if="!items.length">No hay archivos pendientes.</p>
      <template v-else>
        <ul class="list">
          <li v-for="p in items" :key="p.id" class="item" :class="{ done: stateOf(p.id)?.kind === 'ok' }">
            <div class="head">
              <b class="name">{{ fileName(p.path) }}</b>
              <span class="reason">{{ pendingReasonLabel(p.reason) }}</span>
            </div>
            <p class="meta">
              <code>{{ p.path }}</code>
              <span v-if="parsedLabel(p.parsed)"> · {{ parsedLabel(p.parsed) }}</span>
            </p>
            <fieldset v-if="p.candidates.length" class="candidates">
              <legend>¿Cuál es?</legend>
              <label v-for="c in p.candidates" :key="`${c.tmdbType}${c.tmdbId}`" class="candidate">
                <input v-model="picks[p.id]" type="radio" :name="`pick-${p.id}`" :value="`${c.tmdbType}:${c.tmdbId}`" />
                <span>{{ candidateLabel(c) }}</span>
              </label>
            </fieldset>
            <div v-else class="manual">
              <label>
                Tipo
                <select v-model="manualType[p.id]">
                  <option value="tv">Serie</option>
                  <option value="movie">Película</option>
                </select>
              </label>
              <label>
                ID de TMDB
                <input v-model="manualId[p.id]" type="number" min="1" inputmode="numeric" />
              </label>
            </div>
            <div class="actions">
              <template v-if="stateOf(p.id)?.kind !== 'ok'">
                <button type="button" class="primary" :disabled="stateOf(p.id)?.kind === 'busy' || !choice(p)" @click="confirmRow(p)">
                  Confirmar
                </button>
                <button type="button" :disabled="stateOf(p.id)?.kind === 'busy'" @click="ignoreRow(p)">Ignorar</button>
              </template>
              <span v-if="stateOf(p.id)" class="row-state" :class="stateOf(p.id)!.kind" role="status">{{ stateOf(p.id)!.text }}</span>
            </div>
          </li>
        </ul>
        <button type="button" @click="load">Actualizar lista</button>
      </template>
    </template>
    <p v-else class="help">Cargando…</p>
  </main>
</template>

<style scoped>
.pending { max-width: min(960px, 100%); margin: 0 auto; padding: calc(var(--header-h) + 24px) var(--gutter) 48px; display: grid; gap: 16px; }
h1 { margin: 0; }
.help { color: var(--text-dim); font-size: 0.9rem; margin: 0; }
.list { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
.item { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-card); display: grid; gap: 8px; }
.item.done { opacity: 0.65; }
.head { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.name { overflow-wrap: anywhere; }
.reason { flex: none; color: var(--warn); font-size: 0.85rem; font-weight: 600; text-align: left; }
.meta { margin: 0; color: var(--text-dim); font-size: 0.9rem; overflow-wrap: anywhere; }
.candidates { margin: 0; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 4px; }
.candidates legend { padding: 0 6px; color: var(--text-dim); font-size: 0.8rem; }
.candidate { display: flex; align-items: center; gap: 8px; min-height: 36px; font-size: 0.92rem; }
.manual { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.manual label { display: flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 0.85rem; }
.manual input { width: 8em; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.actions .primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
.row-state { font-size: 0.85rem; color: var(--text-dim); }
.row-state.ok { color: var(--ok); }
.row-state.error { color: var(--danger); }
</style>
