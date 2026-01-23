
import { el } from '../utils/dom.js';

export function renderStart(app) {
  const page = el('div', 'page');
  page.innerHTML = `
    <div class="topbar">
      <div class="badge">BabyMonitor Web</div>
    </div>

    <div class="center">
      <div class="card" style="width:min(560px, 100%); padding:18px;">
        <div class="h1">Choose a device role</div>
        <div class="sub">Use one device as the camera near the baby, and another as the monitor.</div>

        <div style="height:14px"></div>
        <div class="selectRow">
          <button class="btn full" id="camera">Use as Camera</button>
          <button class="btn full ghost" id="monitor">Use as Monitor</button>
        </div>

        <div style="height:10px"></div>
        <div class="small">
          Tip: For best performance, keep both devices on the same Wi‑Fi network. If your network is restrictive, enable TURN in <span class="badge mono" style="padding:3px 8px;">js/webrtc/turn.js</span>.
        </div>
      </div>
    </div>
  `;

  page.querySelector('#camera').onclick = () => location.hash = '#/camera';
  page.querySelector('#monitor').onclick = () => location.hash = '#/monitor';

  app.appendChild(page);
}
