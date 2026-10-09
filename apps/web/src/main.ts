import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { getProfileId } from './api.ts';
import { loadTheme } from './theme.ts';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: (to, from, saved) => saved ?? (to.path === from.path ? undefined : { top: 0 }),
  routes: [
    { path: '/', component: () => import('./views/ProfilesView.vue'), meta: { chrome: false } },
    { path: '/browse', component: () => import('./views/HomeView.vue') },
    { path: '/browse/:kind(series|movies|anime)', component: () => import('./views/GridView.vue') },
    { path: '/my-list', component: () => import('./views/GridView.vue') },
    { path: '/search', component: () => import('./views/GridView.vue') },
    { path: '/title/:id(\\d+)', component: () => import('./views/TitleView.vue') },
    { path: '/watch/:mediaFileId(\\d+)', component: () => import('./views/WatchView.vue'), meta: { chrome: false } },
    { path: '/titles', redirect: '/browse' },
    { path: '/titles/:id(\\d+)', redirect: (to) => `/title/${to.params.id}` },
  ],
});

router.beforeEach((to) => (to.path !== '/' && !getProfileId() ? '/' : true));

loadTheme(getProfileId());
createApp(App).use(router).mount('#app');
