<script setup lang="ts" generic="T">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{ title: string; items: T[]; keyOf: (item: T) => string | number }>();

const scroller = ref<HTMLElement | null>(null);
const canLeft = ref(false);
const canRight = ref(false);

function update() {
  const el = scroller.value;
  if (!el) return;
  canLeft.value = el.scrollLeft > 4;
  canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
}
const page = (dir: 1 | -1) =>
  scroller.value?.scrollBy({ left: dir * scroller.value.clientWidth * 0.85, behavior: 'smooth' });

let ro: ResizeObserver | undefined;
onMounted(() => {
  update();
  ro = new ResizeObserver(update);
  if (scroller.value) ro.observe(scroller.value);
});
onBeforeUnmount(() => ro?.disconnect());
watch(() => props.items.length, () => nextTick(update));
</script>

<template>
  <section v-if="items.length" class="row">
    <h2>{{ title }}</h2>
    <div class="wrap">
      <button v-show="canLeft" class="arrow left" aria-label="Anterior" @click="page(-1)"><Icon name="left" :size="26" /></button>
      <ul ref="scroller" class="scroller" @scroll.passive="update">
        <li v-for="it in items" :key="keyOf(it)"><slot :item="it" /></li>
      </ul>
      <button v-show="canRight" class="arrow right" aria-label="Siguiente" @click="page(1)"><Icon name="right" :size="26" /></button>
    </div>
  </section>
</template>

<style scoped>
.row { margin: 0 0 8px; }
h2 { margin: 0 var(--gutter); font-size: clamp(1.1rem, 1.6vw, 1.4rem); letter-spacing: -0.005em; }
.wrap { position: relative; }
.scroller {
  display: flex; gap: clamp(10px, 1.2vw, 18px); list-style: none; margin: 0; padding: 22px var(--gutter) 30px;
  overflow-x: auto; scroll-snap-type: x proximity; scroll-padding-inline: var(--gutter);
  scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
.scroller::-webkit-scrollbar { display: none; }
.scroller li { flex: none; scroll-snap-align: start; }
.arrow {
  position: absolute; top: calc(50% - 4px); z-index: 6; display: grid; place-items: center;
  width: 44px; height: 44px; min-height: 0; padding: 0; border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.28); background: rgba(8, 8, 12, 0.92); color: #fff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); transform: translateY(-50%);
  transition: background 0.15s, border-color 0.15s, transform 0.15s;
}
.left { left: 8px; }
.right { right: 8px; }
.arrow:hover { background: rgba(56, 56, 74, 0.98); border-color: #fff; transform: translateY(-50%) scale(1.06); }
@media (hover: none) { .arrow { display: none; } }
</style>
