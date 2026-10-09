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
      <button v-show="canLeft" class="arrow left" tabindex="-1" aria-label="Anterior" @click="page(-1)"><Icon name="left" :size="34" /></button>
      <ul ref="scroller" class="scroller" @scroll.passive="update">
        <li v-for="it in items" :key="keyOf(it)"><slot :item="it" /></li>
      </ul>
      <button v-show="canRight" class="arrow right" tabindex="-1" aria-label="Siguiente" @click="page(1)"><Icon name="right" :size="34" /></button>
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
  position: absolute; top: 22px; bottom: 30px; z-index: 5; display: grid; place-items: center;
  width: clamp(40px, 4vw, 64px); min-height: 0; padding: 0; border-radius: 0; color: #fff; opacity: 0;
  transition: opacity 0.15s;
}
.left { left: 0; background: linear-gradient(90deg, rgba(8, 8, 12, 0.85), transparent); }
.right { right: 0; background: linear-gradient(270deg, rgba(8, 8, 12, 0.85), transparent); }
.arrow:hover { background-color: transparent; }
.wrap:hover .arrow, .arrow:focus-visible { opacity: 1; }
@media (hover: none) { .arrow { display: none; } }
</style>
