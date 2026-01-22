import { el } from '../utils/dom.js';

export function renderStart(app) {
  const page = el('div', 'page safe');
  page.innerHTML = `
    <div class="card" style="padding:18px;">
      <div class="h1">BabyMonitor Web</div>
      <div class="spacer"></div>
      <div class="p">Use two devices: one as <b>Camera</b> in the baby’s room, one as <b>Monitor</b>.</div>
      <div class="spacer"></div>
      <div class="row">
        <button class="btn primary grow" id="goCamera">Use as Camera</button>
        <button class="btn grow" id="goMonitor">Use as Monitor</button>
      </div>
      <div class="spacer"></div>
      <div class="small">Tip: Keep the Camera device plugged in.</div>
    </div>
  `;
  page.querySelector('#goCamera').onclick = () => location.hash = '#/camera';
  page.querySelector('#goMonitor').onclick = () => location.hash = '#/monitor';
  app.appendChild(page);
}
