import { el, toast } from '../utils/dom.js';
import { state } from '../state.js';
import { roomExists } from '../webrtc/signaling.js';

export function renderMonitor(app) {
  state.role = 'monitor';

  const page = el('div', 'page safe');
  page.innerHTML = `
    <div class="card" style="padding:18px;">
      <div class="h1">Connect as Monitor</div>
      <div class="spacer"></div>
      <div class="p">Enter the 6-character code shown on the Camera device.</div>
      <div class="spacer"></div>
      <input class="input mono" id="code" maxlength="6" placeholder="ABC123" autocapitalize="characters" />
      <div class="spacer"></div>
      <div class="row">
        <button class="btn primary grow" id="connect">Connect</button>
        <button class="btn ghost" id="back">Back</button>
      </div>
      <div class="spacer"></div>
      <div class="small">If you haven’t set up Firebase yet, connection will not work.</div>
    </div>
  `;
  app.appendChild(page);

  const codeEl = page.querySelector('#code');
  codeEl.addEventListener('input', () => {
    codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0,6);
  });

  page.querySelector('#back').onclick = () => location.hash = '#/';

  page.querySelector('#connect').onclick = async () => {
    const code = codeEl.value.trim();
    if (code.length !== 6) { toast(page, 'Enter 6 characters'); return; }
    state.roomCode = code;

    try {
      const ok = await roomExists(code);
      if (!ok) { toast(page, 'Code not found'); return; }
    } catch {
      toast(page, 'Firebase not configured. Update firebase config.');
      return;
    }

    location.hash = '#/monitor/live';
  };
}
