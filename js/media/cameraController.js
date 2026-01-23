
/**
 * Camera control helper.
 * - Enumerate video input devices
 * - Switch active device via deviceId
 * - Best-effort zoom (if supported)
 * - Best-effort facingMode fallback
 */
export async function ensurePermissions() {
  // Needed on iOS/Safari to reveal device labels
  const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  tmp.getTracks().forEach(t => t.stop());
}

export async function getCameraDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'videoinput');
}

export function supportsZoom(track) {
  try {
    const caps = track.getCapabilities?.();
    return !!(caps && caps.zoom);
  } catch { return false; }
}

export async function applyZoom(track, value) {
  const caps = track.getCapabilities?.();
  if (!caps?.zoom) throw new Error('Zoom not supported');
  const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, value));
  await track.applyConstraints({ advanced: [{ zoom: z }] });
  return z;
}

export function getZoomRange(track) {
  const caps = track.getCapabilities?.();
  if (!caps?.zoom) return null;
  return { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step ?? 0.1 };
}

export function portraitVideoConstraints(targetHeight=1280) {
  // Helps laptops default to landscape; forces portrait aspect if possible
  return {
    width: { ideal: Math.round(targetHeight * 9/16) },
    height: { ideal: targetHeight },
    aspectRatio: { ideal: 9/16 },
    frameRate: { ideal: 30, max: 30 }
  };
}

export async function startStreamForDevice(deviceId, withAudio=true) {
  const constraints = {
    video: deviceId ? { deviceId: { exact: deviceId }, ...portraitVideoConstraints(1280) }
                    : { facingMode: { ideal: 'environment' }, ...portraitVideoConstraints(1280) },
    audio: withAudio
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

export async function switchToDevice(currentStream, deviceId) {
  currentStream?.getTracks().forEach(t => t.stop());
  const stream = await startStreamForDevice(deviceId, true);
  return stream;
}

export async function switchFacing(currentFacing='environment') {
  const next = currentFacing === 'user' ? 'environment' : 'user';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { exact: next }, ...portraitVideoConstraints(1280) },
    audio: true
  });
  return { stream, facing: next };
}
