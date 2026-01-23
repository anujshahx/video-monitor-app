
import { buildIceServers } from './turn.js';

export function createPeer() {
  return new RTCPeerConnection({
    iceServers: buildIceServers(),
    iceCandidatePoolSize: 2
  });
}

/**
 * Dynamic downscale + bitrate hint (best-effort; not supported everywhere)
 * - Use on the SENDER side after tracks added.
 */
export async function applySenderQualityHints(peer, { maxBitrate=900_000, scaleDownBy=1.0 } = {}) {
  const senders = peer.getSenders().filter(s => s.track && s.track.kind === 'video');
  for (const sender of senders) {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].scaleResolutionDownBy = scaleDownBy;
    try { await sender.setParameters(params); } catch {}
  }
}
