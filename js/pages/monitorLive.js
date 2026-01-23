
import { state } from '../state.js';
import { el, toast } from '../utils/dom.js';
import { formatElapsed } from '../utils/timers.js';
import { createPeer } from '../webrtc/peer.js';
import { listenForOffer, sendAnswer, addIceCandidate, listenIceCandidates, setStatus } from '../webrtc/signaling.js';
import { attachAudioMeter } from '../media/audioLevel.js';

function connBadge(peer){
  const s = peer.iceConnectionState;
  if (s === 'connected' || s === 'completed') return { label:'Good', cls:'ok' };
  if (s === 'checking' || s === 'new') return { label:'Connecting', cls:'warn' };
  return { label:'Poor', cls:'bad' };
}

function dcSend(msg) {
  const ch = state.dataChannel;
  if (!ch || ch.readyState !== 'open') return false;
  ch.send(JSON.stringify(msg));
  return true;
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
      <div class="toast"> </div>

      <!-- overlay controls like baby monitor apps -->
      <div class="overlayBar">
        <div class="pillStack">
          <button class="pill" id="ptt" title="Push to talk (prototype)">🎙️</button>
          <button class="pill" id="motionToggle" title="Motion alerts">👀</button>
        </div>
        <div class="pillStack">
          <div class="pill small" id="quality">Quality: Auto</div>
        </div>
      </div>
    </div>

    <div class="controls">
      <div class="card" style="padding:12px;">
        <div class="row" style="justify-content:space-between;align-items:flex-end;">
          <div style="flex:1;">
            <div class="small">Incoming audio</div>
            <div class="meter" style="margin-top:6px;"><div id="audBar"></div></div>
          </div>
          <button class="btn small ghost" id="end">End</button>
        </div>

        <div style="height:12px"></div>

        <div class="controlsGrid">
          <button class="btn" id="white">White Noise</button>
          <button class="btn" id="rain">Rain</button>
          <button class="btn" id="lullaby">Lullaby</button>
          <button class="btn danger" id="stop">Stop</button>
        </div>

        <div style="height:12px"></div>

        <div class="row" style="justify-content:space-between; align-items:center;">
          <div class="small">Camera selection</div>
          <button class="btn small ghost" id="refreshCams">Refresh</button>
        </div>
        <div style="height:8px"></div>
        <div id="cams" class="col"></div>

        <div style="height:10px"></div>
        <div class="small">If video is patchy, tap “Quality: Auto” to downscale.</div>
      </div>
    </div>
  `;
  app.appendChild(page);

  const connEl = page.querySelector('#conn');
  const timerEl = page.querySelector('#timer');
  const remoteVideo = page.querySelector('#remote');
  const audBar = page.querySelector('#audBar');
  const camsEl = page.querySelector('#cams');
  const qualityEl = page.querySelector('#quality');

  const peer = createPeer();
  state.peer = peer;

  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  peer.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  };

  // When camera creates datachannel, we attach and keep ref
  peer.ondatachannel = (ev) => {
    state.dataChannel = ev.channel;
    state.dataChannel.onmessage = (e) => {
      try { handleMsg(JSON.parse(e.data)); } catch {}
    };
    state.dataChannel.onopen = () => {
      toast(page, 'Controls ready');
      requestCameras();
    };
  };

  function handleMsg(msg){
    if (msg.type === 'motion') {
      if (state.motionAlertsEnabled) toast(page, 'Motion detected');
    }
    if (msg.type === 'cameras_list') {
      renderCameraList(msg.cameras || []);
    }
  }

  // ICE handling
  peer.onicecandidate = (ev) => {
    if (ev.candidate) addIceCandidate(state.roomCode, 'monitor', ev.candidate.toJSON());
  };

  listenIceCandidates(state.roomCode, 'camera', async (cand) => {
    try { await peer.addIceCandidate(cand); } catch {}
  });

  // Signaling: wait for offer then answer
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

  // UI updates
  setInterval(() => {
    const b = connBadge(peer);
    connEl.textContent = b.label;
    connEl.className = 'badge ' + b.cls;
    if (state.connectionStartTime) timerEl.textContent = formatElapsed(Date.now() - state.connectionStartTime);
  }, 400);


  // Best-effort network adaptation (monitor side): if packet loss/jitter high, request downscale
  let lastHintAt = 0;
  setInterval(async () => {
    try {
      if (!peer || peer.connectionState !== 'connected') return;
      const stats = await peer.getStats();
      let inbound;
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
      });
      if (!inbound) return;

      const now = Date.now();
      const packetsLost = inbound.packetsLost ?? 0;
      const packetsReceived = inbound.packetsReceived ?? 0;
      const lossPct = packetsReceived ? (packetsLost / (packetsReceived + packetsLost)) : 0;
      const jitter = inbound.jitter ?? 0;

      // If loss > 4% or jitter high, request downscale once every 12s
      if ((lossPct > 0.04 || jitter > 0.05) && (now - lastHintAt) > 12000) {
        lastHintAt = now;
        dcSend({ type:'quality_hint', maxBitrate: 650000, scaleDownBy: 1.7 });
        toast(page, 'Network weak: downscaling');
      }
    } catch {}
  }, 4000);

  // Audio meter (monitor side)
  const meterStop = attachAudioMeter(remoteStream, (pct) => {
    audBar.style.width = Math.round(pct*100) + '%';
  });

  // Motion toggle
  const motionBtn = page.querySelector('#motionToggle');
  function syncMotionLabel(){
    motionBtn.textContent = state.motionAlertsEnabled ? '👀' : '🙈';
  }
  syncMotionLabel();
  motionBtn.onclick = () => {
    state.motionAlertsEnabled = !state.motionAlertsEnabled;
    syncMotionLabel();
    toast(page, state.motionAlertsEnabled ? 'Motion alerts on' : 'Motion alerts off');
  };

  // Sound controls: send to camera
  page.querySelector('#white').onclick = () => {
    if (!dcSend({ type:'sound', action:'white' })) toast(page, 'Controls not ready');
  };
  page.querySelector('#rain').onclick = () => {
    if (!dcSend({ type:'sound', action:'rain' })) toast(page, 'Controls not ready');
  };
  page.querySelector('#lullaby').onclick = () => {
    if (!dcSend({ type:'sound', action:'lullaby' })) toast(page, 'Controls not ready');
  };
  page.querySelector('#stop').onclick = () => {
    if (!dcSend({ type:'sound', action:'stop' })) toast(page, 'Controls not ready');
  };

  // Quality toggle (dynamic downscale request)
  let qualityMode = 0; // 0 auto, 1 balanced, 2 low
  const qualityModes = [
    { label:'Quality: Auto', hint:null },
    { label:'Quality: Balanced', hint:{ maxBitrate: 900_000, scaleDownBy: 1.3 } },
    { label:'Quality: Low', hint:{ maxBitrate: 550_000, scaleDownBy: 1.8 } }
  ];
  function syncQuality(){
    qualityEl.textContent = qualityModes[qualityMode].label;
  }
  syncQuality();
  qualityEl.onclick = () => {
    qualityMode = (qualityMode + 1) % qualityModes.length;
    syncQuality();
    const hint = qualityModes[qualityMode].hint;
    if (hint) {
      if (!dcSend({ type:'quality_hint', ...hint })) toast(page, 'Controls not ready');
      else toast(page, 'Requested downscale');
    } else {
      toast(page, 'Auto mode');
    }
  };

  // Camera list request & selection
  function requestCameras(){
    dcSend({ type:'request_cameras' });
  }

  function renderCameraList(cameras){
    camsEl.innerHTML = '';
    if (!cameras.length) {
      camsEl.innerHTML = '<div class="small">No camera list available yet. Try Refresh.</div>';
      return;
    }
    cameras.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'btn ghost small';
      b.textContent = c.label;
      b.onclick = () => {
        if (!dcSend({ type:'select_camera', deviceId: c.id })) toast(page, 'Controls not ready');
        else toast(page, 'Switching camera…');
      };
      camsEl.appendChild(b);
    });
  }

  page.querySelector('#refreshCams').onclick = () => {
    if (!dcSend({ type:'request_cameras' })) toast(page, 'Controls not ready');
  };

  // End
  page.querySelector('#end').onclick = () => {
    try { meterStop?.(); } catch {}
    try { peer.close(); } catch {}
    location.hash = '#/';
  };
}
