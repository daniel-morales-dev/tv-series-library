<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { api } from '../api.ts';
import { useDismiss } from '../dismiss.ts';
import { crumbs, pickerError, type DirListing } from '../folderPicker.ts';
import Icon from './Icon.vue';

const props = defineProps<{ start?: string }>();
const emit = defineEmits<{ pick: [path: string]; close: [] }>();

const root = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);
const listing = ref<DirListing | null>(null);
const error = ref('');
const loading = ref(false);
let opener: HTMLElement | null = null;

useDismiss(root, () => {
  close();
  return true;
});

async function open(path?: string) {
  loading.value = true;
  error.value = '';
  try {
    listing.value = await api.dirs(path);
  } catch (e) {
    error.value = pickerError(e instanceof Error ? e.message : '');
    // First open with a bad typed path: fall back to the server's home so the picker is still usable.
    if (!listing.value && path) await open();
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await open(props.start);
  await nextTick();
  root.value?.querySelector<HTMLElement>('[data-first]')?.focus();
});

function close() {
  emit('close');
  opener?.focus();
}

function pick() {
  if (listing.value) emit('pick', listing.value.path);
}

function onKey(e: KeyboardEvent) {
  const items = [...(list.value?.querySelectorAll<HTMLElement>('button.item') ?? [])];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault();
    items[Math.min(i + 1, items.length - 1)]?.focus();
  } else if (e.key === 'ArrowUp' && i > 0) {
    e.preventDefault();
    items[i - 1]?.focus();
  } else if (e.key === 'Tab' && root.value) {
    const f = [...root.value.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="veil" />
    <div ref="root" class="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title" @keydown="onKey">
      <header class="head">
        <h2 id="picker-title">Elegir carpeta</h2>
        <button type="button" class="x" aria-label="Cerrar" @click="close"><Icon name="close" /></button>
      </header>

      <div v-if="listing" class="shortcuts" aria-label="Accesos rápidos">
        <button v-for="s in listing.shortcuts" :key="s.path" type="button" class="chip" :title="s.path" @click="open(s.path)">
          {{ s.name }}
        </button>
      </div>

      <nav v-if="listing" class="crumbs" aria-label="Ruta actual">
        <button type="button" class="up" :disabled="!listing.parent || loading" aria-label="Subir una carpeta" @click="open(listing.parent!)">
          <Icon name="up" :size="18" />
        </button>
        <template v-for="(c, i) in crumbs(listing.path)" :key="c.path">
          <span v-if="i > 0" class="sep" aria-hidden="true">/</span>
          <button type="button" class="crumb" :aria-current="i === crumbs(listing.path).length - 1 ? 'location' : undefined" @click="open(c.path)">
            {{ c.name }}
          </button>
        </template>
      </nav>

      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <div ref="list" class="list" :aria-busy="loading">
        <button v-for="(d, i) in listing?.entries ?? []" :key="d.path" type="button" class="item" :data-first="i === 0 ? '' : undefined" @click="open(d.path)">
          <Icon name="folder" :size="20" />
          <span>{{ d.name }}</span>
        </button>
        <p v-if="listing && !listing.entries.length && !loading" class="empty">Esta carpeta no tiene subcarpetas.</p>
      </div>

      <footer class="foot">
        <code v-if="listing" class="cur">{{ listing.path }}</code>
        <div class="row">
          <button type="button" @click="close">Cancelar</button>
          <button type="button" class="primary" data-first :disabled="!listing || loading" @click="pick">Usar esta carpeta</button>
        </div>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 70; background: rgba(6, 6, 10, 0.6); }
.picker {
  position: fixed; z-index: 71; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; width: min(560px, calc(100vw - 24px)); max-height: min(640px, calc(100dvh - 24px));
  background: var(--bg-raised); color: var(--text); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow);
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 10px 10px 20px; border-bottom: 1px solid var(--line); }
.head h2 { margin: 0; font-size: 1.1rem; letter-spacing: -0.01em; }
.x { display: grid; place-items: center; min-height: 0; width: 40px; height: 40px; padding: 0; border-radius: 50%; background: none; color: var(--text-dim); }
.x:hover { background: var(--bg-hover); color: var(--text); }
.shortcuts { display: flex; gap: 8px; padding: 12px 16px 0; overflow-x: auto; scrollbar-width: thin; }
.chip { flex: none; min-height: 40px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg-card); color: var(--text); white-space: nowrap; }
.chip:hover { background: var(--bg-hover); }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; padding: 10px 16px 6px; color: var(--text-dim); }
.up { display: grid; place-items: center; min-height: 0; width: 40px; height: 40px; padding: 0; margin-right: 4px; border-radius: 10px; background: var(--bg-card); color: var(--text); }
.up:disabled { opacity: 0.4; }
.crumb { min-height: 40px; padding: 0 8px; border-radius: 8px; background: none; color: var(--text-dim); }
.crumb:hover { background: var(--bg-hover); color: var(--text); }
.crumb[aria-current] { color: var(--text); font-weight: 700; }
.sep { opacity: 0.5; }
.err { margin: 0; padding: 4px 16px; color: var(--danger); }
.list { flex: 1; min-height: 120px; overflow-y: auto; padding: 4px 8px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.list[aria-busy='true'] { opacity: 0.6; }
.item { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 0 12px; border-radius: 10px; background: none; color: var(--text); text-align: left; }
.item:hover { background: var(--bg-hover); }
.item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { margin: 16px 12px; color: var(--text-dim); }
.foot { display: grid; gap: 10px; padding: 12px 16px 16px; }
.cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; color: var(--text-dim); }
.row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
</style>
