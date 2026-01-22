// WebRTC Peer wrapper with optional TURN support
// 🔴 PLACEHOLDER: If you add TURN, edit TURN_CONFIG in js/webrtc/turn.js
import { TURN_CONFIG, buildIceServers } from './turn.js';

export function createPeer() {
  const iceServers = buildIceServers();
  return new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 2
  });
}
