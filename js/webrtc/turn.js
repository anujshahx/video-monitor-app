// TURN integration (optional)
// Works on GitHub Pages because it's pure client config.
// 🔴 PLACEHOLDER: If you have TURN credentials, set enabled=true and fill urls/username/credential.

export const TURN_CONFIG = {
  enabled: false,
  urls: [
    // "turn:turn.yourdomain.com:3478?transport=udp",
    // "turns:turn.yourdomain.com:5349?transport=tcp"
  ],
  username: "YOUR_TURN_USERNAME",
  credential: "YOUR_TURN_CREDENTIAL"
};

export function buildIceServers() {
  const servers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];
  if (TURN_CONFIG.enabled) {
    servers.push({
      urls: TURN_CONFIG.urls,
      username: TURN_CONFIG.username,
      credential: TURN_CONFIG.credential
    });
  }
  return servers;
}
