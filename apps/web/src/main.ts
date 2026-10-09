import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { getProfileId } from './api.ts';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/ProfilesView.vue') },
    { path: '/titles', component: () => import('./views/TitlesView.vue') },
    { path: '/titles/:id(\\d+)', component: () => import('./views/TitleView.vue') },
    { path: '/watch/:mediaFileId(\\d+)', component: () => import('./views/WatchView.vue') },
  ],
});

router.beforeEach((to) => (to.path !== '/' && !getProfileId() ? '/' : true));

createApp(App).use(router).mount('#app');
