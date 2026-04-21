// =========================================================
// Baby Monitor — app.js
// WebRTC + Firebase signaling, native-app-feel navigation,
// numpad join, motion detection, signal strength, camera picker.
// =========================================================

// ---------- Firebase ----------
const firebaseConfig = {
  apiKey: "AIzaSyBjtdeKEtw_FpcMC6Ab4uE2V9pZLAxr0dQ",
  authDomain: "baby-monitor-b862d.firebaseapp.com",
  databaseURL: "https://baby-monitor-b862d-default-rtdb.firebaseio.com/",
  projectId: "baby-monitor-b862d",
  storageBucket: "baby-monitor-b862d.firebasestorage.app",
  messagingSenderId: "802534707567",
  appId: "1:802534707567:web:36d267b573f903bf25d89a"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

auth.signInAnonymously().catch(err => console.error('Auth error', err));
auth.onAuthStateChanged(user => console.log('DEBUG: auth state', user ? user.uid : null));

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ---------- Session state ----------
let pc = null;
let localStream = null;            // camera device
let cameraAudioTrack = null;
let monitorMicStream = null;
let monitorMicTrack = null;
let dataChannel = null;
let pingTimer = null;
let currentRoomCode = null;
let answerListenerRef = null;

// Camera-side specific
let motionStop = null;             // fn to stop motion detection loop
let availableCameras = [];         // [{id, label, kind}]
let activeCameraId = null;

// Monitor-side specific
let statsTimer = null;             // signal strength polling
let notifyCtx = null;              // audio ctx for short beep on motion

// Camera-side audio (sounds)
let audioCtx = null;
let gain = null;
let currentOsc = null;
let currentSrc = null;
let melodyTimer = null;
let melodyActive = false;

// Monitor numpad state
let pinDigits = [];
let joinInFlight = false;

const log = (...a) => console.log('[BM]', ...a);

// =========================================================
// Navigation stack
// =========================================================
const nav = (() => {
  const stack = [];
  let animating = false;
  const ANIM_MS = 320;

  const get = (id) => document.getElementById(id);
  const wait = () => new Promise(r => setTimeout(r, ANIM_MS));

  async function push(id, onEnter) {
    if (animating) return;
    const prevId = stack[stack.length - 1];
    if (prevId === id) return;

    const next = get(id);
    if (!next) return;

    const prev = prevId ? get(prevId) : null;

    if (prev) { prev.classList.add('under'); prev.classList.remove('active'); }
    next.classList.add('active');
    next.classList.remove('under');

    stack.push(id);
    try { history.pushState({ navId: id, depth: stack.length }, ''); } catch {}

    animating = true;
    await wait();
    animating = false;

    if (typeof onEnter === 'function') {
      try { onEnter(); } catch (e) { console.error('nav onEnter error', e); }
    }
  }

  async function _popDom() {
    if (stack.length <= 1) return;
    const leavingId = stack.pop();
    const targetId  = stack[stack.length - 1];
    const leaving   = get(leavingId);
    const target    = targetId ? get(targetId) : null;

    if (leaving) {
      leaving.classList.remove('active');
      leaving.classList.remove('under');
    }
    if (target) {
      // Target becomes the new top-of-stack. It had `.under` while a deeper
      // screen was pushed on top of it; strip that and ensure it is `.active`
      // so the CSS transform puts it back on stage (the default .screen rule
      // translates off-screen if neither active nor data-root).
      target.classList.remove('under');
      target.classList.add('active');
    }

    animating = true;
    await wait();
    animating = false;
  }

  function current() { return stack[stack.length - 1]; }
  function depth()   { return stack.length; }

  function init() {
    const root = document.querySelector('.screen[data-root]');
    if (!root) { console.error('nav: no [data-root] screen'); return; }
    stack.push(root.id);
    try { history.replaceState({ navId: root.id, depth: 1, root: true }, ''); } catch {}
  }

  window.addEventListener('popstate', async () => {
    if (stack.length > 1) {
      const needsTeardown =
        pc || localStream || monitorMicStream || dataChannel || currentRoomCode;
      if (needsTeardown) { try { teardownSession(); } catch (e) { console.error(e); } }
      await _popDom();
    }
  });

  return { push, current, depth, init };
})();

// =========================================================
// UI helpers
// =========================================================
function setStatus(id, kind, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status ' + kind;
  el.style.display = 'block';
  el.textContent = msg;
}
const showInfo    = (id, msg) => setStatus(id, 'info',    msg);
const showOk      = (id, msg) => setStatus(id, 'success', msg);
const showErr     = (id, msg) => setStatus(id, 'error',   msg);
const hideStatus  = (id)       => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

function setConnDot(id, state) {
  const el = document.getElementById(id);
  if (el) el.setAttribute('data-state', state);
}

function showLiveOverlay(msg) {
  const el = document.getElementById('liveOverlay');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideLiveOverlay() {
  const el = document.getElementById('liveOverlay');
  if (el) el.classList.add('hidden');
}

function setSignalStrength(bars) {
  const el = document.getElementById('signalBars');
  if (!el) return;
  const clamped = Math.max(0, Math.min(4, bars | 0));
  el.setAttribute('data-strength', String(clamped));
}

// =========================================================
// Back / home handling
// =========================================================
function goBack() {
  if (nav.depth() > 1) history.back();
}
function goHome() { goBack(); }

function openCamera() {
  nav.push('screen-camera', () => {
    showInfo('cameraStatus', 'Starting camera…');
    setConnDot('cameraConnDot', 'pending');
    startCamera();
  });
}

function openMonitor() {
  resetPin();
  nav.push('screen-monitor');
}

// =========================================================
// Teardown — clean reset without a page reload
// =========================================================
function teardownSession() {
  try { if (pingTimer) clearInterval(pingTimer); } catch {}
  pingTimer = null;

  try { if (statsTimer) clearInterval(statsTimer); } catch {}
  statsTimer = null;

  try { if (motionStop) motionStop(); } catch {}
  motionStop = null;

  try { if (answerListenerRef) answerListenerRef.off(); } catch {}
  answerListenerRef = null;

  try { if (dataChannel) dataChannel.close(); } catch {}
  dataChannel = null;

  try {
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onicegatheringstatechange = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.ondatachannel = null;
      pc.close();
    }
  } catch {}
  pc = null;

  try { if (localStream) localStream.getTracks().forEach(t => t.stop()); } catch {}
  localStream = null;
  cameraAudioTrack = null;

  try { if (monitorMicStream) monitorMicStream.getTracks().forEach(t => t.stop()); } catch {}
  monitorMicStream = null;
  monitorMicTrack  = null;

  try { stopSoundOnCamera(); } catch {}

  availableCameras = [];
  activeCameraId = null;

  if (currentRoomCode) {
    try { db.ref('rooms/' + currentRoomCode).remove(); } catch {}
  }
  currentRoomCode = null;

  // Reset media elements
  const camVideo     = document.getElementById('cameraVideo');
  const monVideo     = document.getElementById('monitorVideo');
  const remoteAudio  = document.getElementById('remoteAudio');
  if (camVideo)    camVideo.srcObject    = null;
  if (monVideo)    monVideo.srcObject    = null;
  if (remoteAudio) remoteAudio.srcObject = null;

  // Reset UI
  const roomCodeDisplay = document.getElementById('roomCodeDisplay');
  if (roomCodeDisplay) roomCodeDisplay.textContent = '— — — —';

  const micBtn = document.getElementById('micBtn');
  if (micBtn) { micBtn.disabled = true; micBtn.classList.remove('active'); }

  const soundSelect  = document.getElementById('soundSelect');
  const cameraSelect = document.getElementById('cameraSelect');
  if (soundSelect)  { soundSelect.disabled = true;  soundSelect.value = ''; }
  if (cameraSelect) {
    cameraSelect.disabled = true;
    cameraSelect.innerHTML = '<option value="">—</option>';
  }

  setSignalStrength(0);

  const liveOverlay = document.getElementById('liveOverlay');
  if (liveOverlay) { liveOverlay.textContent = 'Connecting…'; liveOverlay.classList.remove('hidden'); }

  const liveVideo = document.querySelector('#screen-live .live-video');
  if (liveVideo) liveVideo.classList.remove('motion-flash');
  const motionBanner = document.getElementById('motionBanner');
  if (motionBanner) motionBanner.classList.remove('flash');

  hideStatus('cameraStatus');
  hideStatus('monitorStatus');

  setConnDot('cameraConnDot',  'idle');

  resetPin();
}

// =========================================================
// Utilities
// =========================================================
function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Only true ultra-wide / 0.5x lenses should be marked 'wide'. iOS labels
// like "Back Dual Wide Camera" refer to the *main* back camera, NOT the
// ultra-wide lens, so a bare "wide" match would misclassify it.
function classifyCamera(label) {
  const s = (label || '').toLowerCase();
  if (/ultra[-\s]*wide|ultrawide|super[-\s]*wide|0\.5\s*x|\b0\.5\b/.test(s)) return 'wide';
  return 'standard';
}

function isFrontCamera(label) {
  return /front|selfie|facetime|user/i.test(label || '');
}

// Pick the rear cameras and expose at most one Standard + one Wide option.
async function enumerateCamerasClassified() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch { return []; }

  const videos = devices.filter(d => d.kind === 'videoinput');

  // Strictly exclude front-facing cameras — a baby monitor should never
  // default to the selfie lens.
  const rear = videos.filter(d => !isFrontCamera(d.label));

  // If labels are empty (permission race), fall back to all videos.
  const pool = rear.length ? rear : videos;

  const classified = pool.map((d, i) => ({
    id: d.deviceId,
    label: d.label || ('Camera ' + (i + 1)),
    kind: classifyCamera(d.label)
  }));

  // Choose the first entry of each kind.
  const std   = classified.find(c => c.kind === 'standard');
  const wide  = classified.find(c => c.kind === 'wide');

  const out = [];
  if (std)  out.push({ id: std.id,  kind: 'standard', label: 'Standard'   });
  if (wide) out.push({ id: wide.id, kind: 'wide',     label: 'Wide Angle' });

  // Fallback: ensure at least one option is surfaced.
  if (!out.length && classified.length) {
    out.push({ id: classified[0].id, kind: 'standard', label: 'Standard' });
  }
  return out;
}

// =========================================================
// CAMERA side
// =========================================================
async function startCamera() {
  try {
    // Intentionally NO `aspectRatio` constraint. iPhone sensors are
    // natively 4:3; forcing 9:16 here makes iOS crop ~25% of the horizontal
    // FOV from whichever lens it picks, which defeats the point of having
    // a wide-angle lens at all. Let iOS hand us the native sensor frame —
    // the monitor side letterboxes it with `object-fit: contain`.
    const baseConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 1280 },
        frameRate: { ideal: 24, max: 30 }
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    };

    localStream = await navigator.mediaDevices.getUserMedia(baseConstraints);

    const camVideo = document.getElementById('cameraVideo');
    camVideo.srcObject = localStream;

    cameraAudioTrack = localStream.getAudioTracks()[0] || null;
    const vTrack = localStream.getVideoTracks()[0];
    activeCameraId = vTrack?.getSettings?.().deviceId || null;

    // Enumerate cameras after permission is granted (so labels are populated).
    availableCameras = await enumerateCamerasClassified();

    // Start motion detection on local preview.
    motionStop = startMotionDetection(camVideo, () => {
      sendCtrl({ action: 'motion', ts: Date.now() });
    }, { fps: 6, cooldownMs: 8000, threshold: 18000 });

    pc = new RTCPeerConnection(rtcConfig);

    dataChannel = pc.createDataChannel('ctrl');
    dataChannel.onopen  = () => log('Camera DC open');
    dataChannel.onclose = () => log('Camera DC close');
    dataChannel.onerror = (e) => log('Camera DC error', e);
    dataChannel.onmessage = (ev) => onCameraCtrl(ev);

    localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));

    // Remote audio from monitor (talk-back)
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio' && e.streams[0]) {
        const ra = document.getElementById('remoteAudio');
        ra.srcObject = e.streams[0];
        ra.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      log('Camera PC state', pc.connectionState);
      if (pc.connectionState === 'connected') {
        setConnDot('cameraConnDot', 'live');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setConnDot('cameraConnDot', 'error');
      }
    };

    const gathered = [];
    pc.onicecandidate = (ev) => { if (ev.candidate) gathered.push(ev.candidate); };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState !== 'complete') return;

      const offerPkg = {
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        candidates: gathered.map(c => c.toJSON())
      };

      const roomCode = generateRoomCode();
      currentRoomCode = roomCode;

      db.ref('rooms/' + roomCode + '/offer').set(offerPkg)
        .then(() => {
          document.getElementById('roomCodeDisplay').textContent = roomCode;
          showOk('cameraStatus', 'Ready. Share code ' + roomCode + ' with the Monitor.');
          setConnDot('cameraConnDot', 'pending');

          answerListenerRef = db.ref('rooms/' + roomCode + '/answer');
          answerListenerRef.on('value', async snap => {
            const answer = snap.val();
            if (!answer || !pc || pc.signalingState === 'stable') return;
            try {
              await pc.setRemoteDescription(answer.sdp);
              if (answer.candidates) {
                for (const c of answer.candidates) { await pc.addIceCandidate(c); }
              }
              showOk('cameraStatus', 'Connected to Monitor via room ' + roomCode);
              setConnDot('cameraConnDot', 'live');
            } catch (err) {
              showErr('cameraStatus', 'Error applying answer: ' + err.message);
              setConnDot('cameraConnDot', 'error');
            }
          });
        })
        .catch(err => {
          console.error('offer write FAILED', err);
          showErr('cameraStatus', 'Firebase error: ' + err.message);
          setConnDot('cameraConnDot', 'error');
        });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

  } catch (err) {
    showErr('cameraStatus', 'Error: ' + err.message);
    setConnDot('cameraConnDot', 'error');
  }
}

// Camera handling incoming control messages.
async function onCameraCtrl(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  log('Camera got', msg);

  if (msg.action === 'play')  return playSoundOnCamera(msg.sound);
  if (msg.action === 'stop')  return stopSoundOnCamera();
  if (msg.action === 'ping')  return sendCtrl({ action: 'ready' });

  if (msg.action === 'request_cameras') {
    if (!availableCameras.length) {
      availableCameras = await enumerateCamerasClassified();
    }
    return sendCtrl({
      action: 'cameras',
      options: availableCameras.map(c => ({ id: c.id, kind: c.kind, label: c.label })),
      active: activeCameraId
    });
  }

  if (msg.action === 'select_camera' && msg.id && msg.id !== activeCameraId) {
    try { await switchCameraTo(msg.id); }
    catch (err) { log('switch failed', err); }
  }
}

async function switchCameraTo(deviceId) {
  if (!pc || !localStream) return;

  // Keep existing audio track; just swap video.
  const keepAudio = localStream.getAudioTracks()[0] || null;

  // Stop the old video tracks FIRST — some mobile browsers refuse to
  // open a second camera while another is still active on the device.
  localStream.getVideoTracks().forEach(t => t.stop());

  const newStream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: deviceId },
      width:  { ideal: 1280 },
      height: { ideal: 1280 },
      frameRate: { ideal: 24, max: 30 }
    },
    audio: false
  });

  const newV = newStream.getVideoTracks()[0];
  if (!newV) return;

  // Build a fresh stream so the preview element reflects the new track.
  const composed = new MediaStream();
  composed.addTrack(newV);
  if (keepAudio) composed.addTrack(keepAudio);
  localStream = composed;

  const camVideo = document.getElementById('cameraVideo');
  if (camVideo) camVideo.srcObject = localStream;

  // Replace the video sender's track (no renegotiation needed).
  const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (vSender) await vSender.replaceTrack(newV);

  activeCameraId = deviceId;

  // Restart motion detection against the refreshed preview element.
  try { if (motionStop) motionStop(); } catch {}
  motionStop = startMotionDetection(camVideo, () => {
    sendCtrl({ action: 'motion', ts: Date.now() });
  }, { fps: 6, cooldownMs: 8000, threshold: 18000 });
}

function sendCtrl(msg) {
  try {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify(msg));
      return true;
    }
  } catch {}
  return false;
}

// =========================================================
// Motion detection (canvas frame diff)
// Ported from video-monitor-app reference.
// =========================================================
function startMotionDetection(videoEl, onMotion, opts = {}) {
  const fps        = opts.fps        ?? 6;
  const cooldownMs = opts.cooldownMs ?? 8000;
  const threshold  = opts.threshold  ?? 18000;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let last = null;
  let lastAlert = 0;
  const interval = Math.max(80, Math.floor(1000 / fps));

  const handle = setInterval(() => {
    if (!videoEl || !videoEl.videoWidth || videoEl.readyState < 2) return;

    const w = 160, h = 120;
    canvas.width = w; canvas.height = h;
    try { ctx.drawImage(videoEl, 0, 0, w, h); } catch { return; }

    let frame;
    try { frame = ctx.getImageData(0, 0, w, h).data; } catch { return; }

    if (last) {
      let diff = 0;
      for (let i = 0; i < frame.length; i += 4) {
        diff += Math.abs(frame[i] - last[i]);
      }
      if (diff > threshold && (Date.now() - lastAlert) > cooldownMs) {
        lastAlert = Date.now();
        try { onMotion(); } catch (e) { log('motion cb err', e); }
      }
    }
    last = frame;
  }, interval);

  return () => { try { clearInterval(handle); } catch {} };
}

// =========================================================
// MONITOR numpad
// =========================================================
function resetPin() {
  pinDigits = [];
  renderPin();
  hideStatus('monitorStatus');
  const btn = document.getElementById('connectBtn');
  if (btn) btn.disabled = true;
}

function renderPin() {
  for (let i = 0; i < 4; i++) {
    const cell = document.getElementById('pinDot' + (i + 1));
    if (!cell) continue;
    const d = pinDigits[i];
    if (d != null) {
      cell.textContent = d;
      cell.classList.add('filled');
      cell.classList.remove('empty');
    } else {
      cell.textContent = '';
      cell.classList.remove('filled');
      cell.classList.add('empty');
    }
  }
  const btn = document.getElementById('connectBtn');
  if (btn) btn.disabled = pinDigits.length !== 4;
}

function onNumKey(key) {
  if (key === 'back') {
    if (pinDigits.length > 0) pinDigits.pop();
  } else if (pinDigits.length < 4) {
    pinDigits.push(key);
    if (document.getElementById('monitorStatus')?.style.display === 'block') {
      hideStatus('monitorStatus');
    }
  }
  renderPin();
  if (pinDigits.length === 4) {
    // Small delay so the UI update lands before network call starts.
    setTimeout(() => joinRoom(), 80);
  }
}

function wireNumpad() {
  const pad = document.getElementById('numpad');
  if (!pad) return;
  pad.addEventListener('click', (e) => {
    const b = e.target.closest('.numkey');
    if (!b) return;
    const key = b.getAttribute('data-key');
    if (!key) return;
    onNumKey(key);
  });

  // Keyboard support (hardware keys) when on the monitor screen.
  document.addEventListener('keydown', (e) => {
    if (nav.current() !== 'screen-monitor') return;
    if (/^[0-9]$/.test(e.key)) { onNumKey(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { onNumKey('back'); e.preventDefault(); }
    else if (e.key === 'Enter' && pinDigits.length === 4) { joinRoom(); e.preventDefault(); }
  });
}

// =========================================================
// MONITOR side
// =========================================================
async function joinRoom() {
  if (joinInFlight) return;
  const code = pinDigits.join('');
  if (code.length !== 4) {
    showErr('monitorStatus', 'Enter the 4-digit code first.');
    return;
  }
  joinInFlight = true;
  const btn = document.getElementById('connectBtn');
  if (btn) btn.disabled = true;

  showInfo('monitorStatus', 'Looking up room ' + code + '…');
  currentRoomCode = code;

  try {
    const snap = await db.ref('rooms/' + code + '/offer').get();
    if (!snap.exists()) {
      showErr('monitorStatus', 'No camera found for this code.');
      currentRoomCode = null;
      if (btn) btn.disabled = false;
      joinInFlight = false;
      return;
    }
    const offer = snap.val();
    hideStatus('monitorStatus');

    nav.push('screen-live', () => {
      showLiveOverlay('Connecting…');
      setSignalStrength(0);
      createAnswerFromOffer(offer, code);
      joinInFlight = false;
    });
  } catch (err) {
    showErr('monitorStatus', 'Firebase error: ' + err.message);
    if (btn) btn.disabled = false;
    joinInFlight = false;
  }
}

async function createAnswerFromOffer(offer, roomCode) {
  try {
    pc = new RTCPeerConnection(rtcConfig);

    pc.ondatachannel = (ev) => {
      dataChannel = ev.channel;
      log('Monitor received DC', dataChannel.label);
      dataChannel.onopen = () => {
        log('Monitor DC open');
        startPinging();
        // Ask camera about available lenses.
        setTimeout(() => sendCtrl({ action: 'request_cameras' }), 150);
      };
      dataChannel.onmessage = (e) => onMonitorCtrl(e);
      dataChannel.onclose = () => log('Monitor DC close');
      dataChannel.onerror = (er) => log('Monitor DC error', er);
    };

    pc.onconnectionstatechange = () => {
      log('Monitor PC state', pc.connectionState);
      if ((pc.connectionState === 'connected' || pc.connectionState === 'completed') &&
          dataChannel && dataChannel.readyState === 'open') {
        enableLiveControls();
        hideLiveOverlay();
        stopPinging();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        showLiveOverlay('Connection lost');
        setSignalStrength(0);
      }
    };

    // iOS Safari sometimes stays in `new`/`checking` on `connectionState`
    // even when iceConnectionState reaches `connected`/`completed`. Use the
    // ICE state as a reliable fallback signal.
    pc.oniceconnectionstatechange = () => {
      log('Monitor ICE state', pc.iceConnectionState);
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        hideLiveOverlay();
        if (!statsTimer) startStatsPolling();
      } else if (s === 'failed' || s === 'disconnected') {
        setSignalStrength(0);
      }
    };

    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        const vid = document.getElementById('monitorVideo');
        if (vid) vid.srcObject = e.streams[0];
        hideLiveOverlay();
        // Begin polling as soon as media starts flowing. This is the most
        // reliable trigger on iOS Safari.
        if (!statsTimer) startStatsPolling();
        if (monitorMicTrack) {
          const micBtn = document.getElementById('micBtn');
          if (micBtn) micBtn.disabled = false;
        }
      }
    };

    // Monitor mic (muted by default)
    try {
      monitorMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      monitorMicTrack = monitorMicStream.getAudioTracks()[0];
      monitorMicTrack.enabled = false;
      pc.addTrack(monitorMicTrack, monitorMicStream);
    } catch (e) {
      log('Monitor mic denied', e);
    }

    const gathered = [];
    pc.onicecandidate = (ev) => { if (ev.candidate) gathered.push(ev.candidate); };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState !== 'complete') return;

      const answerPkg = {
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        candidates: gathered.map(c => c.toJSON())
      };

      db.ref('rooms/' + roomCode + '/answer').set(answerPkg)
        .catch(err => {
          showLiveOverlay('Firebase error: ' + err.message);
        });
    };

    await pc.setRemoteDescription(offer.sdp);
    if (offer.candidates) {
      for (const c of offer.candidates) { await pc.addIceCandidate(c); }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

  } catch (err) {
    showLiveOverlay('Error: ' + err.message);
  }
}

// Monitor handling incoming control messages from camera.
function onMonitorCtrl(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  log('Monitor got', msg);

  if (msg.action === 'ready') {
    enableLiveControls();
    hideLiveOverlay();
  }
  if (msg.action === 'motion') {
    triggerMotionAlert();
  }
  if (msg.action === 'cameras') {
    populateCameraSelect(msg.options || [], msg.active);
  }
}

function populateCameraSelect(options, activeId) {
  const sel = document.getElementById('cameraSelect');
  if (!sel) return;

  sel.innerHTML = '';
  if (!options.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '—';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }

  for (const c of options) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.label || (c.kind === 'wide' ? 'Wide Angle' : 'Standard');
    sel.appendChild(o);
  }
  if (activeId && options.some(o => o.id === activeId)) sel.value = activeId;
  sel.disabled = options.length < 2;
}

function onCameraSelect(id) {
  if (!id) return;
  sendCtrl({ action: 'select_camera', id });
}

// =========================================================
// Signal strength polling (inbound-rtp video stats)
// =========================================================
function startStatsPolling() {
  try { if (statsTimer) clearInterval(statsTimer); } catch {}
  let lastLost = 0, lastRecv = 0;
  let primed = false;
  setSignalStrength(3);

  statsTimer = setInterval(async () => {
    if (!pc) return;
    // Accept both `connectionState` and `iceConnectionState` — Safari is
    // inconsistent about which reaches the connected state first.
    const cs  = pc.connectionState;
    const ics = pc.iceConnectionState;
    const alive =
      cs  === 'connected' || cs  === 'completed' ||
      ics === 'connected' || ics === 'completed';
    if (!alive) return;

    try {
      const stats = await pc.getStats();
      let inbound;
      stats.forEach(r => {
        // `kind` is the modern field; `mediaType` is what older Safari/
        // WebKit return. Match either.
        const k = r.kind || r.mediaType;
        if (r.type === 'inbound-rtp' && k === 'video') inbound = r;
      });
      if (!inbound) return;

      const lost  = inbound.packetsLost ?? 0;
      const recv  = inbound.packetsReceived ?? 0;
      const jit   = inbound.jitter ?? 0;

      const dLost = Math.max(0, lost - lastLost);
      const dRecv = Math.max(0, recv - lastRecv);
      lastLost = lost; lastRecv = recv;

      // First tick primes the deltas — don't score anything yet.
      if (!primed) { primed = true; return; }

      if (dRecv === 0) {
        setSignalStrength(1);
        return;
      }

      const lossPct = dLost / (dLost + dRecv);
      let bars = 4;
      if (lossPct > 0.10 || jit > 0.12) bars = 1;
      else if (lossPct > 0.05 || jit > 0.07) bars = 2;
      else if (lossPct > 0.02 || jit > 0.04) bars = 3;
      setSignalStrength(bars);
    } catch (err) {
      log('getStats error', err);
    }
  }, 1500);
}

// =========================================================
// Motion alert (monitor): green flash + chip + short beep
// =========================================================
function triggerMotionAlert() {
  const vid    = document.querySelector('#screen-live .live-video');
  const banner = document.getElementById('motionBanner');
  if (vid) {
    vid.classList.remove('motion-flash');
    // Force reflow so animation restarts cleanly on re-trigger
    void vid.offsetWidth;
    vid.classList.add('motion-flash');
    setTimeout(() => vid.classList.remove('motion-flash'), 2500);
  }
  if (banner) {
    banner.classList.remove('flash');
    void banner.offsetWidth;
    banner.classList.add('flash');
    setTimeout(() => banner.classList.remove('flash'), 2500);
  }
  try { playNotificationBeep(); } catch {}
}

function playNotificationBeep() {
  if (!notifyCtx) {
    try {
      notifyCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return; }
  }
  if (notifyCtx.state === 'suspended') {
    notifyCtx.resume().catch(() => {});
  }
  const ctx2 = notifyCtx;
  const now = ctx2.currentTime;

  // Two short pings — musical, not jarring.
  const makePing = (freq, startOffset) => {
    const osc = ctx2.createOscillator();
    const g = ctx2.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, now + startOffset);
    g.gain.linearRampToValueAtTime(0.22, now + startOffset + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + 0.35);
    osc.connect(g).connect(ctx2.destination);
    osc.start(now + startOffset);
    osc.stop(now + startOffset + 0.4);
  };
  makePing(880, 0);
  makePing(1320, 0.14);
}

// =========================================================
// Ping / DC handshake
// =========================================================
function startPinging() {
  stopPinging();
  pingTimer = setInterval(() => {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    try { dataChannel.send(JSON.stringify({ action: 'ping' })); } catch {}
  }, 800);
}
function stopPinging() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

// Enable Sound dropdown once camera is ready.
function enableLiveControls() {
  const sel = document.getElementById('soundSelect');
  if (sel) sel.disabled = false;
  stopPinging();
}

// =========================================================
// Push-to-talk
// =========================================================
function startTalking() {
  const btn = document.getElementById('micBtn');
  if (!btn || btn.disabled) return;
  btn.classList.add('active');
  if (monitorMicTrack) monitorMicTrack.enabled = true;
}
function stopTalking() {
  const btn = document.getElementById('micBtn');
  if (!btn) return;
  btn.classList.remove('active');
  if (monitorMicTrack) monitorMicTrack.enabled = false;
}

// =========================================================
// Sound dropdown handler
// =========================================================
function onSoundSelect(kind) {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  if (!kind) {
    try { dataChannel.send(JSON.stringify({ action: 'stop' })); } catch {}
  } else {
    try { dataChannel.send(JSON.stringify({ action: 'play', sound: kind })); } catch {}
  }
}

// =========================================================
// CAMERA: Web Audio helpers
// =========================================================
async function ensureAudioRunning() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gain = audioCtx.createGain();
    gain.gain.value = 0.28;
    gain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }
}

function stopSoundOnCamera() {
  melodyActive = false;
  if (melodyTimer) { try { clearTimeout(melodyTimer); } catch {} melodyTimer = null; }

  try { if (currentOsc) { currentOsc.onended = null; currentOsc.stop(0); } } catch {}
  try { if (currentOsc) currentOsc.disconnect(); } catch {}
  currentOsc = null;

  try { if (currentSrc) { currentSrc.onended = null; currentSrc.stop(0); } } catch {}
  try { if (currentSrc) currentSrc.disconnect(); } catch {}
  currentSrc = null;
}

async function playSoundOnCamera(kind) {
  await ensureAudioRunning();
  stopSoundOnCamera();

  if (kind === 'whitenoise') return playWhiteNoise();
  if (kind === 'rain')       return playRain();
  if (kind === 'lullaby1') return playMelody(
    [261.63, 261.63, 392.00, 392.00, 440.00, 440.00, 392.00, 349.23, 349.23, 329.63, 329.63, 293.66, 293.66, 261.63],
    0.52, 620
  );
  if (kind === 'lullaby2') return playMelody(
    [329.63, 293.66, 293.66, 329.63, 293.66, 261.63, 293.66, 329.63, 329.63, 293.66],
    0.52, 620
  );
}

function playMelody(notes, noteDur = 0.5, gapMs = 620) {
  melodyActive = true;
  let i = 0;
  const step = () => {
    if (!melodyActive) return;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = notes[i];
    osc.connect(gain);
    currentOsc = osc;
    const stopAt = audioCtx.currentTime + noteDur;
    osc.start();
    osc.stop(stopAt);
    osc.onended = () => {
      if (!melodyActive) return;
      i = (i + 1) % notes.length;
      melodyTimer = setTimeout(step, gapMs);
    };
  };
  step();
}

function playWhiteNoise() {
  const frames = audioCtx.sampleRate * 2;
  const buf = audioCtx.createBuffer(1, frames, audioCtx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) ch[i] = Math.random() * 2 - 1;

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(gain);
  src.start(0);
  currentSrc = src;
}

function playRain() {
  const frames = audioCtx.sampleRate * 2;
  const buf = audioCtx.createBuffer(1, frames, audioCtx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) ch[i] = (Math.random() * 2 - 1) * 0.5;

  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(lp);
  lp.connect(gain);
  src.start(0);
  currentSrc = src;
}

// =========================================================
// Boot
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  nav.init();
  wireNumpad();
  resetPin();
});

window.addEventListener('pagehide', () => {
  try { teardownSession(); } catch {}
});
