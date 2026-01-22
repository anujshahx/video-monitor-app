# BabyMonitor Web (GitHub Pages)

A lightweight, production-oriented WebRTC baby monitor web app.

## What you must configure (placeholders)

### 1) Firebase Realtime Database
Edit:
- `js/firebase/config.js`

Replace the placeholder values with your Firebase web app config.
Also enable Realtime Database and set rules from:
- `js/firebase/rules.json`

### 2) TURN (Optional)
Edit:
- `js/webrtc/turn.js`
Set `enabled: true` and provide `urls`, `username`, `credential`.

> TURN requires a real TURN provider (e.g., coturn on a server, Twilio/Nimble/other).
> GitHub Pages hosting is fine because TURN config is client-side.

## Deploy on GitHub Pages
1. Push this repo to GitHub
2. Repo Settings → Pages → Deploy from branch (root)
3. Open your Pages URL

## Notes
- Lens switching is best-effort across browsers. Zoom support depends on device capabilities.
- Motion detection runs on the Camera device and signals motion events over WebRTC DataChannel.
