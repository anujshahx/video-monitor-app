// Incoming audio level meter (monitor side)
export function attachAudioMeter(stream, onLevel) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  let raf;

  function tick() {
    analyser.getByteTimeDomainData(data);
    // RMS
    let sum = 0;
    for (let i=0;i<data.length;i++){
      const v = (data[i]-128)/128;
      sum += v*v;
    }
    const rms = Math.sqrt(sum/data.length); // 0..1
    onLevel(Math.min(1, rms*2.2));
    raf = requestAnimationFrame(tick);
  }
  tick();

  return () => {
    cancelAnimationFrame(raf);
    try { ctx.close(); } catch {}
  };
}
