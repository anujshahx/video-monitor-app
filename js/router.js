import { renderStart } from './pages/start.js';
import { renderCamera } from './pages/camera.js';
import { renderMonitor } from './pages/monitor.js';
import { renderMonitorLive } from './pages/monitorLive.js';

const routes = {
  '/': renderStart,
  '/camera': renderCamera,
  '/monitor': renderMonitor,
  '/monitor/live': renderMonitorLive
};

export function initRouter() {
  window.addEventListener('hashchange', renderRoute);
  renderRoute();
}

function renderRoute() {
  const app = document.getElementById('app');
  const path = location.hash.replace('#', '') || '/';
  app.innerHTML = '';

  const renderFn = routes[path];
  if (!renderFn) {
    const div = document.createElement('div');
    div.className = 'page safe';
    div.innerHTML = '<div class="card" style="padding:18px;">404</div>';
    app.appendChild(div);
    return;
  }

  renderFn(app);
}
