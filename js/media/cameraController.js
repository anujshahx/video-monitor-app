// Camera & lens selection helper.
// On many devices, lens selection is best-effort via constraints like zoom or facingMode.
// We provide: switch front/rear, and attempt zoom if supported.

export async function getCameraDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'videoinput');
}

export function supportsZoom(track) {
  const caps = track.getCapabilities?.();
  return !!(caps && caps.zoom);
}

export async function applyZoom(track, zoomValue) {
  const caps = track.getCapabilities?.();
  if (!caps?.zoom) return false;
  const z = Math.max(caps.zoom.min, Math.min(caps.zoom.max, zoomValue));
  try {
    await track.applyConstraints({ advanced: [{ zoom: z }] });
    return true;
  } catch {
    return false;
  }
}

export async function switchFacing(currentFacing) {
  const next = currentFacing === 'environment' ? 'user' : 'environment';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: next } },
    audio: true
  });
  return { stream, facing: next };
}
