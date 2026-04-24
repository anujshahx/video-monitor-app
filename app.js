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
let connLostTimer = null;          // interval id for repeating alarm beep
let wasEverConnected = false;      // so we don't alert on initial connect phase

// Motion detection settings (monitor is source of truth; camera mirrors)
// Semantics: `mask[i] === true` means "TRACK this cell for motion".
// Default = all cells selected (track everywhere); user can narrow.
const ZONE_COLS = 6;
const ZONE_ROWS = 8;
const ZONE_TOTAL = ZONE_COLS * ZONE_ROWS;
const ZONE_STORAGE_KEY = 'bm_zone_mask_v1';
const MOTION_ENABLED_KEY = 'bm_motion_enabled_v1';
let zoneMaskMonitor = null;         // Array<boolean> length 48 on monitor
let motionEnabledMonitor = null;    // boolean on monitor
let zoneMaskCamera = null;          // { cols, rows, mask } on camera (received)
let motionEnabledCamera = true;     // boolean on camera (received; default true)
let motionSuspendedCamera = false;  // transient: true while monitor has zones overlay open

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

  try { stopConnectionLostBeep(); } catch {}
  const _lv = document.querySelector('#screen-live .live-video');
  if (_lv) _lv.classList.remove('connection-lost');
  wasEverConnected = false;

  // Hide motion-zones overlay if it was open.
  const _zo = document.getElementById('zonesOverlay');
  if (_zo) { _zo.classList.add('hidden'); _zo.setAttribute('aria-hidden', 'true'); }

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

// =========================================================
// Motion settings (monitor-side persistence + transport)
// =========================================================
function defaultZoneMask() {
  return new Array(ZONE_TOTAL).fill(true);
}

function loadZoneMaskFromStorage() {
  try {
    const raw = localStorage.getItem(ZONE_STORAGE_KEY);
    if (!raw) return defaultZoneMask();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === ZONE_TOTAL) {
      return parsed.map(v => !!v);
    }
  } catch {}
  return defaultZoneMask();
}

function loadMotionEnabledFromStorage() {
  try {
    const raw = localStorage.getItem(MOTION_ENABLED_KEY);
    if (raw === 'false') return false;
    if (raw === 'true')  return true;
  } catch {}
  return true; // default: on
}

function saveZoneMaskToStorage(mask) {
  try { localStorage.setItem(ZONE_STORAGE_KEY, JSON.stringify(mask)); } catch {}
}

function saveMotionEnabledToStorage(enabled) {
  try { localStorage.setItem(MOTION_ENABLED_KEY, enabled ? 'true' : 'false'); } catch {}
}

function ensureMonitorZoneMask() {
  if (!zoneMaskMonitor) zoneMaskMonitor = loadZoneMaskFromStorage();
  return zoneMaskMonitor;
}

function ensureMotionEnabled() {
  if (motionEnabledMonitor === null) motionEnabledMonitor = loadMotionEnabledFromStorage();
  return motionEnabledMonitor;
}

// One consolidated message carries both the enabled flag and the mask.
function sendMotionConfigToCamera() {
  sendCtrl({
    action:  'motion_config',
    enabled: ensureMotionEnabled(),
    cols:    ZONE_COLS,
    rows:    ZONE_ROWS,
    mask:    ensureMonitorZoneMask()
  });
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
    // Intentionally NO `aspectRatio` constraint and NO square height. iPhone
    // and iPad sensors are natively 4:3; forcing 9:16 or a square here makes
    // iOS crop ~25% of the horizontal FOV (or, on older iPads like the Pro
    // 9.7 on iOS 15, occasionally deliver a pipeline the receiver can't
    // decode). Let iOS hand us the native sensor frame — the monitor side
    // fills with `object-fit: cover`.
    const baseConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        frameRate: { ideal: 30, max: 30 }
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

    // Start motion detection on local preview. Both mask and enabled flag
    // are supplied by the monitor over the data channel; we read them
    // each tick so updates take effect immediately.
    motionStop = startMotionDetection(camVideo, () => {
      sendCtrl({ action: 'motion', ts: Date.now() });
    }, {
      fps: 6,
      cooldownMs: 8000,
      perPixelDelta:   25,    // ignore per-pixel jitter below this (0..255)
      minAreaFrac:     0.02,  // require 2% of tracked pixels to have moved
      sustainedFrames: 2,     // ...and for 2 consecutive frames
      getMask:    () => zoneMaskCamera,
      getEnabled: () => motionEnabledCamera && !motionSuspendedCamera
    });

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

  if (msg.action === 'motion_config') {
    if (typeof msg.enabled === 'boolean') {
      motionEnabledCamera = msg.enabled;
    }
    if (Array.isArray(msg.mask) && msg.cols && msg.rows &&
        msg.mask.length === msg.cols * msg.rows) {
      zoneMaskCamera = {
        cols: msg.cols,
        rows: msg.rows,
        mask: msg.mask.map(v => !!v)
      };
    }
    log('Camera motion_config', { enabled: motionEnabledCamera, mask: zoneMaskCamera });
  }

  // Transient pause while the monitor has its zones overlay open. Keeps the
  // detection loop from firing spurious alerts while the user is painting
  // zones; getEnabled() resets `last` + `hotStreak` so there's no stale-
  // frame false-positive when we resume.
  if (msg.action === 'motion_suspend') {
    motionSuspendedCamera = !!msg.suspended;
    log('Camera motion_suspend', { suspended: motionSuspendedCamera });
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
  }, {
    fps: 6,
    cooldownMs: 8000,
    perPixelDelta:   25,
    minAreaFrac:     0.02,
    sustainedFrames: 2,
    getMask:    () => zoneMaskCamera,
    getEnabled: () => motionEnabledCamera && !motionSuspendedCamera
  });
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
// Motion detection: downscales the camera frame to 160×120, then — within
// the user-selected zones — classifies each pixel as "changed" or "not
// changed" based on how much its red-channel brightness moved since the last
// frame. A motion alert fires only when a large enough AREA of tracked
// pixels changes AND that change persists across multiple consecutive
// frames. This rejects two major false-positive sources:
//
//   1. Sensor / IR noise — tiny per-pixel flickers are filtered out by
//      `perPixelDelta` (small brightness jitter doesn't count).
//   2. Breathing — a sleeping chest moves a small region with subtle
//      brightness change. Even if some pixels squeak past the per-pixel
//      threshold, the moved AREA is well under `minAreaFrac` (2% of
//      tracked pixels), so no alert.
//
// Real motion (arm fling, head turn, sitting up) lights up hundreds-to-
// thousands of pixels across a wide region, easily clears the area gate,
// and stays above it for more than one frame — so it fires reliably.
function startMotionDetection(videoEl, onMotion, opts = {}) {
  const fps             = opts.fps             ?? 6;
  const cooldownMs      = opts.cooldownMs      ?? 8000;
  const perPixelDelta   = opts.perPixelDelta   ?? 25;    // 0..255 red-channel delta
  const minAreaFrac     = opts.minAreaFrac     ?? 0.02;  // 2% of tracked pixels
  const sustainedFrames = opts.sustainedFrames ?? 2;     // must hold this many frames
  const getMask         = opts.getMask;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let last = null;
  let lastAlert = 0;
  let hotStreak = 0;                   // consecutive frames above area gate
  const interval = Math.max(80, Math.floor(1000 / fps));

  const handle = setInterval(() => {
    // Honor global enable flag — if disabled, skip entirely and reset
    // running state so we don't carry forward a stale `last` frame or
    // half-completed streak when re-enabled.
    if (typeof opts.getEnabled === 'function' && !opts.getEnabled()) {
      last = null;
      hotStreak = 0;
      return;
    }
    if (!videoEl || !videoEl.videoWidth || videoEl.readyState < 2) return;

    // 120×90 = 10 800 pixels — 56% of the old 160×120 budget. At 6 fps
    // that's roughly 65 k pixel ops/s per pass instead of 115 k, and the
    // spatial averaging from the lower resolution also reduces sensor-
    // noise jitter, so detection gets *more* stable, not less.
    const w = 120, h = 90;
    canvas.width = w; canvas.height = h;
    try { ctx.drawImage(videoEl, 0, 0, w, h); } catch { return; }

    let frame;
    try { frame = ctx.getImageData(0, 0, w, h).data; } catch { return; }

    if (last) {
      const maskInfo = typeof getMask === 'function' ? getMask() : null;
      const mask = maskInfo && maskInfo.mask;
      const cols = (mask && maskInfo.cols) || 0;
      const rows = (mask && maskInfo.rows) || 0;
      const total = cols * rows;

      let trackedPixels = 0;
      let changedPixels = 0;
      // Global-mean-shift correction: we make TWO passes over the tracked
      // pixels. Pass 1 computes the mean red-channel delta — this is the
      // frame-wide brightness drift from autoexposure, lighting changes,
      // or IR gain. Pass 2 subtracts that drift from each pixel's delta
      // before thresholding, so only pixels that moved *relative to the
      // rest of the frame* count as real motion. A uniform brightness
      // jump across the whole frame produces a mean ≈ each pixel's delta,
      // so the corrected delta is ≈ 0 and nothing counts. A hand waving
      // produces an outlier cluster whose deltas dwarf the mean, so they
      // still count.
      let deltaSum = 0;

      if (!mask || !total || mask.length !== total) {
        // Fast path: no mask / malformed — evaluate every pixel.
        trackedPixels = w * h;
        for (let i = 0; i < frame.length; i += 4) deltaSum += frame[i] - last[i];
        const meanDelta = deltaSum / trackedPixels;
        for (let i = 0; i < frame.length; i += 4) {
          const d = (frame[i] - last[i]) - meanDelta;
          if (d > perPixelDelta || d < -perPixelDelta) changedPixels++;
        }
      } else {
        let activeCells = 0;
        for (let c = 0; c < total; c++) if (mask[c]) activeCells++;
        // mask[i] === true means "track this cell". If user selected 0
        // cells we have nothing to track, so bail without alerting.
        if (activeCells === 0) { last = frame; hotStreak = 0; return; }

        if (activeCells === total) {
          // Fast path: all cells selected.
          trackedPixels = w * h;
          for (let i = 0; i < frame.length; i += 4) deltaSum += frame[i] - last[i];
          const meanDelta = deltaSum / trackedPixels;
          for (let i = 0; i < frame.length; i += 4) {
            const d = (frame[i] - last[i]) - meanDelta;
            if (d > perPixelDelta || d < -perPixelDelta) changedPixels++;
          }
        } else {
          const cellW = w / cols;
          const cellH = h / rows;

          // Pass 1: sum deltas across tracked pixels.
          for (let y = 0; y < h; y++) {
            const r = (y / cellH) | 0;
            const rowOff = r * cols;
            for (let x = 0; x < w; x++) {
              const c = (x / cellW) | 0;
              if (!mask[rowOff + c]) continue;
              trackedPixels++;
              const i = (y * w + x) * 4;
              deltaSum += frame[i] - last[i];
            }
          }
          const meanDelta = trackedPixels > 0 ? (deltaSum / trackedPixels) : 0;

          // Pass 2: count pixels whose drift-corrected delta exceeds threshold.
          for (let y = 0; y < h; y++) {
            const r = (y / cellH) | 0;
            const rowOff = r * cols;
            for (let x = 0; x < w; x++) {
              const c = (x / cellW) | 0;
              if (!mask[rowOff + c]) continue;
              const i = (y * w + x) * 4;
              const d = (frame[i] - last[i]) - meanDelta;
              if (d > perPixelDelta || d < -perPixelDelta) changedPixels++;
            }
          }
        }
      }

      const frac = trackedPixels > 0 ? (changedPixels / trackedPixels) : 0;

      if (frac >= minAreaFrac) {
        hotStreak++;
        if (hotStreak >= sustainedFrames && (Date.now() - lastAlert) > cooldownMs) {
          lastAlert = Date.now();
          hotStreak = 0;
          try { onMotion(); } catch (e) { log('motion cb err', e); }
        }
      } else {
        hotStreak = 0;
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
        // Ask camera about available lenses, and push the motion config.
        setTimeout(() => {
          sendCtrl({ action: 'request_cameras' });
          sendMotionConfigToCamera();
        }, 150);
      };
      dataChannel.onmessage = (e) => onMonitorCtrl(e);
      dataChannel.onclose = () => log('Monitor DC close');
      dataChannel.onerror = (er) => log('Monitor DC error', er);
    };

    pc.onconnectionstatechange = () => {
      log('Monitor PC state', pc.connectionState);
      const s = pc.connectionState;
      if ((s === 'connected' || s === 'completed') &&
          dataChannel && dataChannel.readyState === 'open') {
        enableLiveControls();
        hideLiveOverlay();
        stopPinging();
        wasEverConnected = true;
        clearConnectionLost();
      } else if (s === 'failed' || s === 'disconnected') {
        setSignalStrength(0);
        if (wasEverConnected) triggerConnectionLost();
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
        wasEverConnected = true;
        clearConnectionLost();
      } else if (s === 'failed' || s === 'disconnected') {
        setSignalStrength(0);
        if (wasEverConnected) triggerConnectionLost();
      }
    };

    pc.ontrack = (e) => {
      log('Monitor ontrack', {
        kind: e.track.kind,
        readyState: e.track.readyState,
        muted: e.track.muted,
        streamTracks: (e.streams[0] && e.streams[0].getTracks().length) || 0
      });
      if (e.track.kind === 'video') {
        const vid = document.getElementById('monitorVideo');
        if (vid) {
          vid.srcObject = e.streams[0];
          // iOS Safari doesn't always auto-play a WebRTC stream that
          // arrives slightly after the user gesture — especially when the
          // camera peer is running an older iOS (e.g. iPad Pro 9.7 on
          // iOS 15). Explicitly nudge playback and surface any failure
          // via logging so we can see silent autoplay blocks.
          const tryPlay = () => {
            const p = vid.play();
            if (p && typeof p.catch === 'function') {
              p.catch(err => log('Monitor video play rejected', err && err.name, err && err.message));
            }
          };
          tryPlay();
          // Also retry once metadata has loaded — some iOS builds only
          // accept play() after loadedmetadata fires.
          vid.onloadedmetadata = () => {
            log('Monitor video loadedmetadata', { w: vid.videoWidth, h: vid.videoHeight });
            tryPlay();
          };
          vid.onplaying = () => log('Monitor video onplaying', { w: vid.videoWidth, h: vid.videoHeight });
          vid.onerror   = () => log('Monitor video onerror',   vid.error && vid.error.code);
        }
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
// Motion-zones overlay (monitor, in-place over the live video)
//   - Gear FAB on the live video opens this overlay
//   - Toggle switch turns motion detection on/off
//   - Grid (visible only when toggle on) lets the user mark which cells
//     the camera should TRACK. Selected = track. Default = all selected.
//   - Changes auto-persist and auto-sync to camera — no Done button.
// =========================================================
function openZonesOverlay() {
  const overlay = document.getElementById('zonesOverlay');
  if (!overlay) return;
  ensureMonitorZoneMask();
  ensureMotionEnabled();

  // Sync controls to current state before showing.
  const toggle = document.getElementById('motionToggle');
  if (toggle) toggle.checked = motionEnabledMonitor;

  renderZoneGrid();
  applyMotionEnabledUi();

  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');

  // Tell the camera to pause detection — avoids spurious alerts firing
  // while the user is painting zones and keeps the UI responsive.
  try { sendCtrl({ action: 'motion_suspend', suspended: true }); } catch {}
}

function closeZonesOverlay() {
  const overlay = document.getElementById('zonesOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');

  // Resume detection. The camera will reset its frame-diff baseline, so
  // the first frame after resume won't trigger a false positive.
  try { sendCtrl({ action: 'motion_suspend', suspended: false }); } catch {}
}

function applyMotionEnabledUi() {
  const grid = document.getElementById('zoneGrid');
  const hint = document.getElementById('zonesHint');
  const on = !!motionEnabledMonitor;
  if (grid) grid.classList.toggle('hidden', !on);
  if (hint) hint.classList.toggle('hidden', !on);
}

function renderZoneGrid() {
  const grid = document.getElementById('zoneGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const mask = ensureMonitorZoneMask();
  for (let i = 0; i < ZONE_TOTAL; i++) {
    const cell = document.createElement('div');
    // Semantic flip: mask[i] === true means "track this cell" → visually
    // highlighted (selected). Unselected cells are transparent.
    cell.className = 'zone-cell' + (mask[i] ? ' selected' : '');
    cell.setAttribute('data-index', String(i));
    grid.appendChild(cell);
  }
  wireZonesDrag(grid);
}

// Tap + drag-to-paint on the zones grid. The first cell the gesture lands on
// defines the paint direction (select if it was empty, deselect if it was
// selected). Every cell the finger enters after that is set to the same
// value, so one gesture can quickly rubber-stamp a row/column.
//
// Why document-level move/up listeners instead of setPointerCapture on the
// grid: on iOS Safari, pointer events can drop reliability once the finger
// leaves the original child, even with capture set. Listening on `document`
// during the gesture is bulletproof. We also register both Pointer and Touch
// listeners so this works on every mobile browser, and guard against
// double-dispatch with an `activeGesture` flag.
function wireZonesDrag(grid) {
  if (!grid || grid._bmDragWired) return;
  grid._bmDragWired = true;

  let active = false;       // gesture in flight?
  let paintOn = false;      // value we're stamping this gesture
  let lastIndex = -1;       // last cell we applied (dedupe)
  let dirty = false;
  let source = null;        // 'pointer' or 'touch' — ignore events from the other source mid-gesture
  let pointerId = null;

  const cellFromPoint = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const cell = el.closest('.zone-cell');
    if (!cell || cell.parentElement !== grid) return null;
    return cell;
  };

  const applyCell = (cell) => {
    if (!cell) return;
    const idx = parseInt(cell.getAttribute('data-index'), 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= ZONE_TOTAL) return;
    if (idx === lastIndex) return;
    lastIndex = idx;

    const mask = ensureMonitorZoneMask();
    if (mask[idx] === paintOn) return;
    mask[idx] = paintOn;
    zoneMaskMonitor = mask;
    cell.classList.toggle('selected', paintOn);
    dirty = true;
  };

  const startGesture = (cell) => {
    const idx = parseInt(cell.getAttribute('data-index'), 10);
    if (!Number.isFinite(idx)) return false;
    const mask = ensureMonitorZoneMask();
    paintOn = !mask[idx];
    active = true;
    lastIndex = -1;
    dirty = false;
    applyCell(cell);
    return true;
  };

  const endGesture = () => {
    if (!active) return;
    active = false;
    source = null;
    pointerId = null;
    lastIndex = -1;
    if (dirty) {
      saveZoneMaskToStorage(zoneMaskMonitor);
      sendMotionConfigToCamera();
    }
    dirty = false;
  };

  // ---- Pointer Events (desktop, modern mobile) ----
  const onPointerMove = (ev) => {
    if (!active || source !== 'pointer') return;
    if (pointerId !== null && ev.pointerId !== pointerId) return;
    const cell = cellFromPoint(ev.clientX, ev.clientY);
    if (cell) applyCell(cell);
    ev.preventDefault();
  };
  const onPointerEnd = (ev) => {
    if (!active || source !== 'pointer') return;
    if (pointerId !== null && ev.pointerId !== pointerId) return;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerEnd);
    document.removeEventListener('pointercancel', onPointerEnd);
    endGesture();
  };

  grid.addEventListener('pointerdown', (ev) => {
    if (active) return;                         // already painting via touch
    if (ev.pointerType === 'touch') return;      // let the touch handlers own it
    if (ev.button !== undefined && ev.button !== 0) return;

    const cell = cellFromPoint(ev.clientX, ev.clientY);
    if (!cell) return;
    if (!startGesture(cell)) return;

    source = 'pointer';
    pointerId = ev.pointerId;
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
    ev.preventDefault();
  });

  // ---- Touch Events (iOS Safari primary path) ----
  const onTouchMove = (ev) => {
    if (!active || source !== 'touch') return;
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    const cell = cellFromPoint(t.clientX, t.clientY);
    if (cell) applyCell(cell);
    // Prevent scroll/zoom while painting.
    if (ev.cancelable) ev.preventDefault();
  };
  const onTouchEnd = () => {
    if (!active || source !== 'touch') return;
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('touchcancel', onTouchEnd);
    endGesture();
  };

  grid.addEventListener('touchstart', (ev) => {
    if (active) return;
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    const cell = cellFromPoint(t.clientX, t.clientY);
    if (!cell) return;
    if (!startGesture(cell)) return;

    source = 'touch';
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    if (ev.cancelable) ev.preventDefault();
  }, { passive: false });
}

function onMotionToggle(enabled) {
  motionEnabledMonitor = !!enabled;
  saveMotionEnabledToStorage(motionEnabledMonitor);
  applyMotionEnabledUi();
  sendMotionConfigToCamera();
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

function ensureNotifyCtx() {
  if (!notifyCtx) {
    try {
      notifyCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return null; }
  }
  if (notifyCtx.state === 'suspended') {
    notifyCtx.resume().catch(() => {});
  }
  return notifyCtx;
}

// Primitive: schedule a single beep on the notify context.
// duration is attack→release; peak holds until ~80% of duration.
function makeBeep(ctx2, freq, startOffset, duration, volume = 0.22, type = 'sine') {
  const osc = ctx2.createOscillator();
  const g   = ctx2.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx2.currentTime + startOffset;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(volume, t0 + Math.min(0.02, duration * 0.2));
  g.gain.setValueAtTime(volume, t0 + duration * 0.75);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ctx2.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// Motion alert — noticeable 4-tone ascending chirp.
function playNotificationBeep() {
  const ctx2 = ensureNotifyCtx();
  if (!ctx2) return;
  // Ascending: G5, B5, D6, E6
  makeBeep(ctx2, 784,  0.00, 0.14, 0.22);
  makeBeep(ctx2, 988,  0.13, 0.14, 0.22);
  makeBeep(ctx2, 1175, 0.26, 0.14, 0.22);
  makeBeep(ctx2, 1319, 0.39, 0.22, 0.25);
}

// Connection-lost alarm — plays a short 3-tone pattern. Called repeatedly
// by startConnectionLostBeep.
function playConnectionLostBeep() {
  const ctx2 = ensureNotifyCtx();
  if (!ctx2) return;
  // Two short alternating tones + descending resolve — deliberately more
  // urgent than the motion chirp.
  makeBeep(ctx2, 660, 0.00, 0.18, 0.28, 'square');
  makeBeep(ctx2, 880, 0.22, 0.18, 0.28, 'square');
  makeBeep(ctx2, 523, 0.46, 0.30, 0.26, 'sine');
}

function startConnectionLostBeep() {
  if (connLostTimer) return;
  // Fire immediately, then repeat every ~1.5s.
  try { playConnectionLostBeep(); } catch {}
  connLostTimer = setInterval(() => {
    try { playConnectionLostBeep(); } catch {}
  }, 1500);
}

function stopConnectionLostBeep() {
  if (connLostTimer) { try { clearInterval(connLostTimer); } catch {} connLostTimer = null; }
}

function triggerConnectionLost() {
  const vid = document.querySelector('#screen-live .live-video');
  if (vid) vid.classList.add('connection-lost');
  showLiveOverlay('Connection lost — reconnecting…');
  startConnectionLostBeep();
}

function clearConnectionLost() {
  const vid = document.querySelector('#screen-live .live-video');
  if (vid) vid.classList.remove('connection-lost');
  stopConnectionLostBeep();
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
