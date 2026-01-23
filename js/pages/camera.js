
import { state } from '../state.js';
import { el, toast } from '../utils/dom.js';
import { createPeer, applySenderQualityHints } from '../webrtc/peer.js';
import { createControlChannel } from '../webrtc/dataChannel.js';
import { createRoom, sendOffer, listenForAnswer, addIceCandidate, listenIceCandidates, setStatus, closeRoom } from '../webrtc/signaling.js';
import { startMotionDetection } from '../media/motionDetector.js';
import { ensurePermissions, getCameraDevices, startStreamForDevice, switchToDevice, supportsZoom, getZoomRange, applyZoom } from '../media/cameraController.js';
import { unlockAudio, playWhiteNoise, playRain, playLullaby, stopSound } from '../media/sounds.js';

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

async function listCamerasSafe() {
  try {
    await ensurePermissions();
    return await getCameraDevices();
  } catch {
    return await getCameraDevices();
  }
}

export async function renderCamera(app) {
  state.role = 'camera';
  state.roomCode = genCode();

  const page = el('div', 'page');
  page.innerHTML = `
    <div class="topbar">
      <div class="badge mono">PAIR CODE <b id="code">${state.roomCode}</b></div>
      <div class="row" style="gap:8px;">
        <button class="btn small ghost" id="copy">Copy</button>
        <button class="btn small danger" id="end">End</button>
      </div>
    </div>

    <div class="videoWrap">
      <video id="local" autoplay muted playsinline></video>
      <div class="toast"> </div>

      <!-- Reels-like overlay controls -->
      <div class="overlayBar">
        <div class="pillStack">
          <button class="pill" id="unlock" title="Enable sounds">🔊</button>
          <button class="pill" id="flipLocal" title="Switch camera">🔁</button>
          <button class="pill" id="zoomIn" title="Zoom in">＋</button>
          <button class="pill" id="zoomOut" title="Zoom out">－</button>
        </div>

        <div class="pillStack">
          <div class="pill small" id="statusPill">Waiting…</div>
        </div>
      </div>
    </div>

    <div class="controls">
      <div class="card" style="padding:12px;">
        <div class="row" style="justify-content:space-between;">
          <div>
            <div class="small">Camera devices detected</div>
            <div class="h1" style="font-size:18px;margin-top:2px;" id="camCount">—</div>
          </div>
          <button class="btn ghost small" id="refresh">Refresh</button>
        </div>

        <div class="small" style="margin-top:10px;">
          Keep this screen awake. If iOS blocks audio, tap 🔊 once to unlock sounds.
        </div>
      </div>
    </div>
  `;
  app.appendChild(page);

  const localVideo = page.querySelector('#local');
  const statusPill = page.querySelector('#statusPill');
  const camCount = page.querySelector('#camCount');

  // Copy pairing code
  page.querySelector('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(state.roomCode); toast(page, 'Copied'); }
    catch { toast(page, 'Copy failed'); }
  };

  // Create initial stream (prefer environment camera)
  let cameras = await listCamerasSafe();
  camCount.textContent = String(cameras.length || 1);

  // Choose a default device: try "back" first by label if available
  let activeDeviceId = cameras[0]?.deviceId || null;
  const back = cameras.find(d => /back|rear|environment/i.test(d.label));
  if (back) activeDeviceId = back.deviceId;

  try {
    state.localStream = await startStreamForDevice(activeDeviceId, true);
    localVideo.srcObject = state.localStream;
  } catch {
    toast(page, 'Camera/mic permissions blocked');
    statusPill.textContent = 'Permissions blocked';
    return;
  }

  // Create room
  try {
    await createRoom(state.roomCode);
  } catch {
    toast(page, 'Firebase not configured. Update js/firebase/config.js');
  }

  // Peer
  const peer = createPeer();
  state.peer = peer;

  // Add tracks
  state.localStream.getTracks().forEach(t => peer.addTrack(t, state.localStream));

  // Dynamic quality (start optimistic; adjust later)
  await applySenderQualityHints(peer, { maxBitrate: 1_200_000, scaleDownBy: 1.0 });

  // Control channel
  state.dataChannel = createControlChannel(peer, async (msg) => {
    // Commands from monitor:
    if (msg.type === 'sound') {
      // Must be unlocked by user gesture at least once on camera device
      if (!msg.action) return;
      if (msg.action === 'stop') return stopSound();
      if (msg.action === 'white') return playWhiteNoise();
      if (msg.action === 'rain') return playRain();
      if (msg.action === 'lullaby') return playLullaby();
    }

    if (msg.type === 'request_cameras') {
      const cams = await listCamerasSafe();
      // Send back labels (may be empty if permissions not granted)
      const payload = cams.map((d, idx) => ({
        id: d.deviceId,
        label: d.label || `Camera ${idx+1}`
      }));
      if (state.dataChannel?.readyState === 'open') {
        state.dataChannel.send(JSON.stringify({ type:'cameras_list', cameras: payload }));
      }
    }

    if (msg.type === 'select_camera' && msg.deviceId) {
      try {
        // Switch to requested device and replace sender tracks
        const old = state.localStream;
        state.localStream = await switchToDevice(old, msg.deviceId);
        localVideo.srcObject = state.localStream;

        const newV = state.localStream.getVideoTracks()[0];
        const vSender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
        if (vSender && newV) await vSender.replaceTrack(newV);

        const newA = state.localStream.getAudioTracks()[0];
        const aSender = peer.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (aSender && newA) await aSender.replaceTrack(newA);

        toast(page, 'Camera changed');
      } catch {
        toast(page, 'Camera change failed');
      }
    }

    if (msg.type === 'quality_hint') {
      // Monitor can suggest lower bitrate/scale when network is poor
      const mb = typeof msg.maxBitrate === 'number' ? msg.maxBitrate : 900_000;
      const sd = typeof msg.scaleDownBy === 'number' ? msg.scaleDownBy : 1.5;
      await applySenderQualityHints(peer, { maxBitrate: mb, scaleDownBy: sd });
      toast(page, 'Adjusted quality');
    }
  });

  // Start motion detection (send event to monitor)
  const stopMotion = startMotionDetection(localVideo, () => {
    if (state.dataChannel?.readyState === 'open') {
      state.dataChannel.send(JSON.stringify({ type:'motion', ts: Date.now() }));
    }
  }, { fps: 6, cooldownMs: 10000, threshold: 20000 });

  // ICE + signaling
  peer.onicecandidate = (ev) => {
    if (ev.candidate) addIceCandidate(state.roomCode, 'camera', ev.candidate.toJSON());
  };

  listenIceCandidates(state.roomCode, 'monitor', async (cand) => {
    try { await peer.addIceCandidate(cand); } catch {}
  });

  // Offer/Answer exchange
  try {
    const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await peer.setLocalDescription(offer);
    await sendOffer(state.roomCode, { type: offer.type, sdp: offer.sdp });
  } catch {
    toast(page, 'Failed to create offer');
  }

  listenForAnswer(state.roomCode, async (answer) => {
    try {
      await peer.setRemoteDescription(answer);
      await setStatus(state.roomCode, 'connected');
      statusPill.textContent = 'Connected';
      toast(page, 'Monitor connected');
    } catch {
      toast(page, 'Failed to set answer');
    }
  });

  // UI overlay controls
  page.querySelector('#unlock').onclick = async () => {
    const ok = await unlockAudio();
    toast(page, ok ? 'Audio enabled' : 'Audio unlock failed');
  };

  // Local flip (best-effort): cycle devices
  async function cycleDevice() {
    cameras = await listCamerasSafe();
    if (!cameras.length) return;
    const idx = cameras.findIndex(d => d.deviceId === activeDeviceId);
    const next = cameras[(idx + 1) % cameras.length];
    activeDeviceId = next.deviceId;
    // Reuse select flow
    try {
      const old = state.localStream;
      state.localStream = await switchToDevice(old, activeDeviceId);
      localVideo.srcObject = state.localStream;

      const newV = state.localStream.getVideoTracks()[0];
      const vSender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vSender && newV) await vSender.replaceTrack(newV);

      const newA = state.localStream.getAudioTracks()[0];
      const aSender = peer.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (aSender && newA) await aSender.replaceTrack(newA);

      toast(page, 'Switched camera');
    } catch {
      toast(page, 'Switch failed');
    }
  }

  page.querySelector('#flipLocal').onclick = cycleDevice;

  // Zoom controls (if supported)
  let zoom = 1.0;
  function getVTrack() { return state.localStream?.getVideoTracks?.()[0]; }
  page.querySelector('#zoomIn').onclick = async () => {
    try {
      const t = getVTrack();
      if (!t || !supportsZoom(t)) return toast(page, 'Zoom not supported');
      const r = getZoomRange(t);
      zoom = Math.min(r.max, zoom + (r.step || 0.5));
      zoom = await applyZoom(t, zoom);
      toast(page, `Zoom ${zoom.toFixed(1)}x`);
    } catch { toast(page, 'Zoom failed'); }
  };
  page.querySelector('#zoomOut').onclick = async () => {
    try {
      const t = getVTrack();
      if (!t || !supportsZoom(t)) return toast(page, 'Zoom not supported');
      const r = getZoomRange(t);
      zoom = Math.max(r.min, zoom - (r.step || 0.5));
      zoom = await applyZoom(t, zoom);
      toast(page, `Zoom ${zoom.toFixed(1)}x`);
    } catch { toast(page, 'Zoom failed'); }
  };

  page.querySelector('#refresh').onclick = async () => {
    cameras = await listCamerasSafe();
    camCount.textContent = String(cameras.length || 1);
    toast(page, 'Refreshed');
  };

  // End session
  async function endSession() {
    try { stopMotion?.(); } catch {}
    try { peer.close(); } catch {}
    try { state.localStream?.getTracks().forEach(t => t.stop()); } catch {}
    try { await setStatus(state.roomCode, 'closed'); } catch {}
    try { await closeRoom(state.roomCode); } catch {}
    location.hash = '#/';
  }

  page.querySelector('#end').onclick = endSession;

  window.addEventListener('beforeunload', () => {
    try { stopMotion?.(); } catch {}
    try { peer.close(); } catch {}
    try { state.localStream?.getTracks().forEach(t => t.stop()); } catch {}
  }, { once: true });
}
