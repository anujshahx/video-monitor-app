// Web Audio based sounds: white noise + simple lullaby placeholder + rain-like noise.
let ctx;
let node;

function ensureCtx(){
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

export async function playWhiteNoise() {
  stopSound();
  const c = ensureCtx();
  const bufferSize = 2 * c.sampleRate;
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i=0;i<bufferSize;i++) data[i] = Math.random()*2-1;

  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  const gain = c.createGain();
  gain.gain.value = 0.22;

  src.connect(gain).connect(c.destination);
  src.start();
  node = src;
}

export async function playRain() {
  // Pink-ish noise via filtering white noise
  stopSound();
  const c = ensureCtx();

  const bufferSize = 2 * c.sampleRate;
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i=0;i<bufferSize;i++) data[i] = Math.random()*2-1;

  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1200;

  const gain = c.createGain();
  gain.gain.value = 0.18;

  src.connect(filter).connect(gain).connect(c.destination);
  src.start();
  node = src;
}

export async function playLullaby() {
  // Simple royalty-free placeholder: sine tones sequence
  stopSound();
  const c = ensureCtx();

  const gain = c.createGain();
  gain.gain.value = 0.10;
  gain.connect(c.destination);

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.connect(gain);
  osc.start();

  const notes = [262, 294, 330, 294, 262, 220, 196, 220]; // C D E D C A G A
  let idx = 0;
  function step(){
    if (!osc) return;
    osc.frequency.setTargetAtTime(notes[idx%notes.length], c.currentTime, 0.02);
    idx++;
    node._to = setTimeout(step, 500);
  }
  node = osc;
  step();
}
