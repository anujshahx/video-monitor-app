export const state = {
  role: null,              // 'camera' | 'monitor'
  roomCode: null,
  peer: null,
  dataChannel: null,

  localStream: null,
  remoteStream: null,

  motionAlertsEnabled: true,
  connectionStartTime: null,

  // audio/sounds
  sound: { current: null, ctx: null },
  // push-to-talk
  ptt: { enabled: false, stream: null, sender: null },
};
