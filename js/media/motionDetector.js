// Lightweight motion detection via downscaled frame differencing.
export function startMotionDetection(videoEl, onMotion, opts={}) {
  const fps = opts.fps ?? 6;
  const cooldownMs = opts.cooldownMs ?? 10000;
  const threshold = opts.threshold ?? 20000;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let last = null;
  let lastAlert = 0;

  const interval = Math.floor(1000 / fps);
  const handle = setInterval(() => {
    if (!videoEl.videoWidth || videoEl.readyState < 2) return;

    const w = 160, h = 120;
    canvas.width = w; canvas.height = h;
    ctx.drawImage(videoEl, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h).data;

    if (last) {
      let diff = 0;
      for (let i=0; i<frame.length; i+=4) {
        diff += Math.abs(frame[i] - last[i]);
      }
      if (diff > threshold && (Date.now() - lastAlert) > cooldownMs) {
        lastAlert = Date.now();
        onMotion();
      }
    }
    last = frame;
  }, interval);

  return () => clearInterval(handle);
}
