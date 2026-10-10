<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.ts';
import { networkView, pickUrl, qrSvg, type NetworkInfo } from '../network.ts';

const info = ref<NetworkInfo | null>(null);
const failed = ref(false);
const selected = ref('');
const copied = ref(false);

const view = computed(() => (info.value ? networkView(info.value) : null));
const url = computed(() => (info.value ? pickUrl(info.value.urls, selected.value) : null));
const svg = computed(() => (url.value ? qrSvg(url.value) : ''));

onMounted(async () => {
  try {
    info.value = await api.network();
  } catch {
    failed.value = true;
  }
});

async function copy() {
  if (!url.value) return;
  try {
    await navigator.clipboard.writeText(url.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // clipboard unavailable (plain http): the url stays visible to copy by hand
  }
}
</script>

<template>
  <section class="net" aria-labelledby="net-title">
    <h2 id="net-title">Ver desde el celular o la TV</h2>
    <p v-if="failed" role="alert">No se pudo consultar la red.</p>
    <p v-else-if="view?.kind === 'empty'">{{ view.message }}</p>
    <div v-else-if="view?.kind === 'ready' && url" class="body">
      <div class="info">
        <p class="help">El celular debe estar en la misma WiFi.</p>
        <p class="url"><code>{{ url }}</code></p>
        <label v-if="view.multiple" class="pick">
          Red
          <select v-model="selected">
            <option v-for="u in view.urls" :key="u" :value="u" :selected="u === url">{{ u }}</option>
          </select>
        </label>
        <button type="button" class="primary" @click="copy">{{ copied ? 'Copiado' : 'Copiar' }}</button>
      </div>
      <div class="qr" role="img" :aria-label="`Código QR para ${url}`" v-html="svg"></div>
    </div>
  </section>
</template>

<style scoped>
.net { display: grid; gap: 12px; }
h2, p { margin: 0; }
.body { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; padding: 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg-card); }
.info { display: grid; gap: 12px; flex: 1 1 280px; min-width: 0; justify-items: start; }
.help { color: var(--text-dim); }
.url code { font-size: clamp(1.1rem, 2.5vw, 1.6rem); overflow-wrap: anywhere; }
.pick { display: grid; gap: 4px; font-size: 0.85rem; color: var(--text-dim); max-width: 100%; }
.pick select { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg-raised); color: var(--text); }
.primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
.qr { flex: 0 0 auto; width: clamp(160px, 28vw, 240px); background: #fff; border-radius: 8px; padding: 4px; }
.qr :deep(svg) { display: block; width: 100%; height: auto; }
@media (max-width: 520px) { .qr { margin: 0 auto; } }
</style>
