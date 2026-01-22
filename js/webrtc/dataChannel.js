export function createControlChannel(peer, onMessage) {
  const ch = peer.createDataChannel('control', { ordered: true });
  ch.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch {}
  };
  return ch;
}

export function attachControlChannel(peer, onMessage) {
  peer.ondatachannel = (ev) => {
    const ch = ev.channel;
    ch.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch {}
    };
  };
}
