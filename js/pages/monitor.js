
import { state } from '../state.js';
import { el, toast } from '../utils/dom.js';

export function renderMonitor(app) {
  state.role = 'monitor';

  const page = el('div', 'page');
  page.innerHTML = `
    <div class="topbar">
      <div class="badge">Monitor</div>
      <button class="btn small ghost" id="back">Back</button>
    </div>

    <div class="center">
      <div class="card" style="width:min(520px, 100%); padding:16px;">
        <div class="h1">Connect</div>
        <div class="sub">Enter the 6-character pairing code shown on the camera device.</div>

        <div style="height:12px"></div>
        <input class="input" id="code" maxlength="6" placeholder="E.g. A9F3KQ" autocapitalize="characters" />

        <div style="height:12px"></div>
        <button class="btn full" id="connect">Start monitoring</button>

        <div style="height:10px"></div>
        <div class="small">Tip: Use Wi‑Fi for smoother video. TURN can improve reliability on strict networks.</div>
      </div>
    </div>
  `;

  page.querySelector('#back').onclick = () => location.hash = '#/';
  page.querySelector('#connect').onclick = () => {
    const code = page.querySelector('#code').value.trim().toUpperCase();
    if (code.length !== 6) return toast(page, 'Enter a 6-character code');
    state.roomCode = code;
    location.hash = '#/monitor/live';
  };

  app.appendChild(page);
}
