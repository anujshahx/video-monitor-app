import { initRouter } from './router.js';

window.addEventListener('DOMContentLoaded', () => {
  // Default route
  if (!location.hash) location.hash = '#/';
  initRouter();
});
