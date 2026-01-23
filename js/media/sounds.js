
/**
 * Sounds played on CAMERA device (controlled by monitor via DataChannel).
 * Uses Web Audio API. iOS requires a user gesture to start AudioContext once.
 */
let ctx = null;
let node = null;
let unlocked = false;

export async function unlockAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!ctx) ctx = new AudioCtx();
    // resume in case it was suspended
    await ctx.resume();
    unlocked = true;
    return true;
  } catch {
    return false;
  }
}

function ensureCtx() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!ctx) ctx = new AudioCtx();
  return ctx;
}

export function stopSound() {
  if (node) {
    try { node.stop?.(); } catch {}
    try { node.disconnect?.(); } catch {}
    node = null;
  }
}

export function playWhiteNoise() {
  stopSound();
  const c = ensureCtx();
  const bufferSize = 2 * c.sampleRate;
  const noiseBuffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const output = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;
  const whiteNoise = c.createBufferSource();
  whiteNoise.buffer = noiseBuffer;
  whiteNoise.loop = true;
  const gain = c.createGain();
  gain.gain.value = 0.18;
  whiteNoise.connect(gain).connect(c.destination);
  whiteNoise.start(0);
  node = whiteNoise;
}

export function playRain() {
  stopSound();
  const c = ensureCtx();
  const bufferSize = 2 * c.sampleRate;
  const noiseBuffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const output = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) output[i] = (Math.random() * 2 - 1) * 0.6;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;

  const biquad = c.createBiquadFilter();
  biquad.type = 'lowpass';
  biquad.frequency.value = 900;

  const gain = c.createGain();
  gain.gain.value = 0.22;

  src.connect(biquad).connect(gain).connect(c.destination);
  src.start();
  node = src;
}

export function playLullaby() {
  stopSound();
  const c = ensureCtx();
  const osc = c.createOscillator();
  osc.type = 'sine';
  const gain = c.createGain();
  gain.gain.value = 0.08;
  osc.connect(gain).connect(c.destination);
  osc.start();

  const notes = [262, 294, 330, 294, 262, 220, 196, 220]; // C D E D C A G A
  let idx = 0;
  function step() {
    if (!osc) return;
    osc.frequency.setTargetAtTime(notes[idx % notes.length], c.currentTime, 0.02);
    idx++;
    node._to = setTimeout(step, 500);
  }
  node = osc;
  step();
}
