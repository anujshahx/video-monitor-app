import { state } from '../state.js';
import { el, toast } from '../utils/dom.js';
import { formatElapsed } from '../utils/timers.js';
import { createPeer } from '../webrtc/peer.js';
import { attachControlChannel } from '../webrtc/dataChannel.js';
import { listenForOffer, sendAnswer, addIceCandidate, listenIceCandidates, setStatus } from '../webrtc/signaling.js';
import { attachAudioMeter } from '../media/audioLevel.js';

import { playWhiteNoise, playRain, playLullaby, stopSound } from '../media/sounds.js';

function connectionQuality(peer) {
  // Best-effort: uses ICE connection state
  const s = peer.iceConnectionState;
  if (s === 'connected' || s === 'completed') return { label:'Good', cls:'ok' };
  if (s === 'checking' || s === 'new') return { label:'Connecting', cls:'warn' };
  return { label:'Poor', cls:'bad' };
}

export async function renderMonitorLive(app) {
  state.role = 'monitor';

  const page = el('div', 'page');
  page.innerHTML = `
    <div class="topbar">
      <div class="badge mono">CODE <b>${state.roomCode ?? '—'}</b></div>
      <div class="row" style="gap:8px; align-items:center;">
        <div class="badge" id="conn">Connecting</div>
        <div class="badge mono" id="timer">00:00</div>
      </div>
    </div>

    <div class="videoWrap">
      <video id="remote" autoplay playsinline></video>
      <div class="overlayToast"><div class="toast">…</div></div>
    </div>

    <div class="controls">
      <div class="col" style="gap:10px;">
        <div>
          <div class="small">Incoming audio</div>
          <div class="meter"><div id="audBar"></div></div>
        </div>

        <div class="controlsGrid">
          <button class="btn" id="motionToggle">Motion Alerts: ON</button>
          <button class="btn" id="flip">Switch Camera</button>

          <button class="btn" id="white">White Noise</button>
          <button class="btn" id="rain">Rain</button>

          <button class="btn" id="lullaby">Lullaby</button>
          <button class="btn danger" id="stop">Stop Sound</button>
        </div>

        <div class="row">
          <button class="btn ghost grow" id="back">End</button>
        </div>

        <div class="small">Lens switching is best-effort across browsers. Zoom supported on some devices only.</div>
      </div>
    </div>
  `;
  app.appendChild(page);

  const connEl = page.querySelector('#conn');
  const timerEl = page.querySelector('#timer');
  const remoteVideo = page.querySelector('#remote');
  const audBar = page.querySelector('#audBar');

  const peer = createPeer();
  state.peer = peer;

  state.remoteStream = new MediaStream();
  remoteVideo.srcObject = state.remoteStream;

  peer.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach(t => state.remoteStream.addTrack(t));
  };

  // Data channel from camera
  attachControlChannel(peer, async (msg) => {
    if (msg.type === 'motion') {
      if (state.motionAlertsEnabled) {
        toast(page, 'Motion detected');
        // tiny beep using AudioContext (no external file)
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          const ctx = new AudioCtx();
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = 880;
          g.gain.value = 0.04;
          o.connect(g).connect(ctx.destination);
          o.start();
          o.stop(ctx.currentTime + 0.12);
          setTimeout(()=>ctx.close(), 250);
        } catch {}
      }
    }
  });

  peer.onicecandidate = (ev) => {
    if (ev.candidate) addIceCandidate(state.roomCode, 'monitor', ev.candidate.toJSON());
  };

  // Signaling: wait for offer, then answer
  let offered = false;
  listenForOffer(state.roomCode, async (offer) => {
    if (offered) return;
    offered = true;
    try {
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await sendAnswer(state.roomCode, { type: answer.type, sdp: answer.sdp });
      await setStatus(state.roomCode, 'connected');
      state.connectionStartTime = Date.now();
      toast(page, 'Connected');
    } catch {
      toast(page, 'Failed to connect');
    }
  });

  // Listen ICE from camera
  listenIceCandidates(state.roomCode, 'camera', async (cand) => {
    try { await peer.addIceCandidate(cand); } catch {}
  });

  // Update connection badge + timer
  const tick = setInterval(() => {
    const q = connectionQuality(peer);
    connEl.textContent = q.label;
    connEl.className = `badge ${q.cls}`;
    if (state.connectionStartTime) timerEl.textContent = formatElapsed(Date.now() - state.connectionStartTime);
  }, 500);

  // Audio meter once audio track present
  let detachMeter = null;
  const meterWatch = setInterval(() => {
    const audioTracks = state.remoteStream.getAudioTracks();
    if (audioTracks.length && !detachMeter) {
      detachMeter = attachAudioMeter(state.remoteStream, (level) => {
        audBar.style.width = `${Math.round(level*100)}%`;
      });
    }
  }, 400);

  // Controls
  const motionBtn = page.querySelector('#motionToggle');
  motionBtn.onclick = () => {
    state.motionAlertsEnabled = !state.motionAlertsEnabled;
    motionBtn.textContent = `Motion Alerts: ${state.motionAlertsEnabled ? 'ON' : 'OFF'}`;
    toast(page, state.motionAlertsEnabled ? 'Motion alerts enabled' : 'Motion alerts disabled');
  };

  // Sound playback on Monitor device (local)
  page.querySelector('#white').onclick = () => playWhiteNoise().catch(()=>toast(page,'Audio blocked until interaction'));
  page.querySelector('#rain').onclick = () => playRain().catch(()=>toast(page,'Audio blocked until interaction'));
  page.querySelector('#lullaby').onclick = () => playLullaby().catch(()=>toast(page,'Audio blocked until interaction'));
  page.querySelector('#stop').onclick = () => { stopSound(); toast(page,'Stopped'); };

  // Best-effort: request camera switch by asking camera page to switch locally (not implemented as command here)
  // We can only switch camera on camera device via user gesture due to permission restrictions in many browsers.
  page.querySelector('#flip').onclick = () => {
    if (state.dataChannel?.readyState === 'open') {
      state.dataChannel.send(JSON.stringify({ type: 'camera_cmd', action: 'flip' }));
      toast(page, 'Requested camera switch');
    } else {
      toast(page, 'Control channel not available');
    }
  };

  function end() {
    clearInterval(tick);
    clearInterval(meterWatch);
    detachMeter?.();
    try { peer.close(); } catch {}
    try { state.remoteStream?.getTracks().forEach(t=>t.stop()); } catch {}
    stopSound();
    location.hash = '#/';
  }

  page.querySelector('#back').onclick = end;

  window.addEventListener('beforeunload', () => {
    clearInterval(tick);
    clearInterval(meterWatch);
    detachMeter?.();
    try { peer.close(); } catch {}
  }, { once: true });
}
