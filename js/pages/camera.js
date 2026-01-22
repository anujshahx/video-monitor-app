import { state } from '../state.js';
import { el, toast } from '../utils/dom.js';
import { createPeer } from '../webrtc/peer.js';
import { createControlChannel } from '../webrtc/dataChannel.js';
import { createRoom, sendOffer, listenForAnswer, addIceCandidate, listenIceCandidates, setStatus, closeRoom } from '../webrtc/signaling.js';
import { startMotionDetection } from '../media/motionDetector.js';
import { switchFacing, supportsZoom, applyZoom } from '../media/cameraController.js';

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

export async function renderCamera(app) {
  state.role = 'camera';
  state.roomCode = genCode();

  const page = el('div', 'page');
  page.innerHTML = `
    <div class="topbar">
      <div class="badge mono">CODE <b>${state.roomCode}</b></div>
      <div class="badge" id="status">Waiting…</div>
    </div>

    <div class="videoWrap">
      <video id="local" autoplay muted playsinline></video>
      <div class="overlayToast"><div class="toast">…</div></div>
    </div>

    <div class="controls">
      <div class="controlsGrid">
        <button class="btn" id="flip">Switch Camera</button>
        <button class="btn" id="zoom">Toggle Zoom</button>
        <button class="btn danger" id="end">End Session</button>
        <button class="btn ghost" id="copy">Copy Code</button>
      </div>
      <div class="small" style="margin-top:10px;">
        Leave this device open. Motion detection runs on-device.
      </div>
    </div>
  `;
  app.appendChild(page);

  const statusEl = page.querySelector('#status');
  const localVideo = page.querySelector('#local');

  let facing = 'environment';
  let zoomed = false;
  let stopMotion = null;

  async function startLocal() {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    localVideo.srcObject = state.localStream;
  }

  try {
    await startLocal();
  } catch (e) {
    toast(page, 'Camera/mic permission required.');
    statusEl.textContent = 'Permissions blocked';
    statusEl.className = 'badge bad';
    return;
  }

  // Create room + peer
  try { await createRoom(state.roomCode); } catch (e) {
    toast(page, 'Firebase not configured. Update firebase config.');
  }

  const peer = createPeer();
  state.peer = peer;

  // Add tracks
  state.localStream.getTracks().forEach(t => peer.addTrack(t, state.localStream));

  // DataChannel (control)
  state.dataChannel = createControlChannel(peer, (msg) => {
    // camera receives commands from monitor
    if (msg.type === 'sound_play') {
      // Played on camera device: implement by monitor sending sound, but we keep it lightweight v1
      // In this build we do NOT play sounds on camera to avoid autoplay restrictions unless user interacts.
    }
    if (msg.type === 'ptt') {
      // push-to-talk could be implemented by adding a separate track; keeping minimal.
    }
    if (msg.type === 'camera_cmd') {
      // best-effort zoom control
      if (msg.action === 'zoom' && typeof msg.value === 'number') {
        const vTrack = state.localStream.getVideoTracks()[0];
        applyZoom(vTrack, msg.value);
      }
    }
  });

  peer.onicecandidate = (ev) => {
    if (ev.candidate) addIceCandidate(state.roomCode, 'camera', ev.candidate.toJSON());
  };

  // Motion detection -> send via datachannel
  stopMotion = startMotionDetection(localVideo, () => {
    if (state.dataChannel?.readyState === 'open') {
      state.dataChannel.send(JSON.stringify({ type: 'motion', ts: Date.now() }));
    }
  }, { fps: 6, cooldownMs: 10000, threshold: 20000 });

  // Create offer
  const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await peer.setLocalDescription(offer);
  await sendOffer(state.roomCode, { type: offer.type, sdp: offer.sdp });

  statusEl.textContent = 'Share code';
  statusEl.className = 'badge warn';

  // Listen for answer
  listenForAnswer(state.roomCode, async (answer) => {
    if (peer.currentRemoteDescription) return;
    await peer.setRemoteDescription(answer);
    statusEl.textContent = 'Connected';
    statusEl.className = 'badge ok';
    setStatus(state.roomCode, 'connected');
    toast(page, 'Monitor connected');
  });

  // Listen ICE from monitor
  listenIceCandidates(state.roomCode, 'monitor', async (cand) => {
    try { await peer.addIceCandidate(cand); } catch {}
  });

  // UI actions
  page.querySelector('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(state.roomCode); toast(page, 'Code copied'); } catch { toast(page, 'Copy failed'); }
  };

  page.querySelector('#flip').onclick = async () => {
    try {
      stopMotion?.();
      state.localStream.getTracks().forEach(t=>t.stop());
      const res = await switchFacing(facing);
      facing = res.facing;
      state.localStream = res.stream;
      localVideo.srcObject = state.localStream;

      // Replace video sender track
      const newV = state.localStream.getVideoTracks()[0];
      const sender = peer.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newV);

      // Replace audio sender track too (keeps mic consistent)
      const newA = state.localStream.getAudioTracks()[0];
      const aSender = peer.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (aSender && newA) await aSender.replaceTrack(newA);

      stopMotion = startMotionDetection(localVideo, () => {
        if (state.dataChannel?.readyState === 'open') state.dataChannel.send(JSON.stringify({ type:'motion', ts:Date.now() }));
      }, { fps: 6, cooldownMs: 10000, threshold: 20000 });

      toast(page, 'Camera switched');
    } catch {
      toast(page, 'Switch failed');
    }
  };

  page.querySelector('#zoom').onclick = async () => {
    const vTrack = state.localStream.getVideoTracks()[0];
    if (!supportsZoom(vTrack)) { toast(page, 'Zoom not supported'); return; }
    zoomed = !zoomed;
    const caps = vTrack.getCapabilities();
    const target = zoomed ? (caps.zoom.min + (caps.zoom.max - caps.zoom.min)*0.75) : caps.zoom.min;
    const ok = await applyZoom(vTrack, target);
    toast(page, ok ? (zoomed ? 'Zoom on' : 'Zoom off') : 'Zoom failed');
  };

  async function endSession() {
    try { stopMotion?.(); } catch {}
    try { peer.close(); } catch {}
    try { state.localStream?.getTracks().forEach(t=>t.stop()); } catch {}
    try { await setStatus(state.roomCode, 'closed'); } catch {}
    try { await closeRoom(state.roomCode); } catch {}
    location.hash = '#/';
  }

  page.querySelector('#end').onclick = endSession;

  window.addEventListener('beforeunload', () => {
    try { stopMotion?.(); } catch {}
    try { peer.close(); } catch {}
    try { state.localStream?.getTracks().forEach(t=>t.stop()); } catch {}
  }, { once: true });
}
