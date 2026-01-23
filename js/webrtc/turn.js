
/**
 * TURN config is OPTIONAL but improves reliability on restrictive networks.
 * Works on GitHub Pages (client-side only).
 *
 * 🔴 PLACEHOLDER: Fill in your TURN credentials if you have them (e.g., Twilio/Nimble/Cloudflare).
 */
export const TURN_CONFIG = {
  enabled: false, // set true to enable TURN
  urls: [
    // "turn:turn.yourdomain.com:3478?transport=udp",
    // "turn:turn.yourdomain.com:3478?transport=tcp"
  ],
  username: "YOUR_TURN_USERNAME",
  credential: "YOUR_TURN_CREDENTIAL"
};

export function buildIceServers() {
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (TURN_CONFIG.enabled && TURN_CONFIG.urls.length) {
    servers.push({
      urls: TURN_CONFIG.urls,
      username: TURN_CONFIG.username,
      credential: TURN_CONFIG.credential
    });
  }
  return servers;
}
