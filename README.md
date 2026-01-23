# BabyMonitor Web (GitHub Pages)

A lightweight, cross-device baby monitor web app using WebRTC + Firebase Realtime Database signaling.

## Where to add Firebase config
Edit: `js/firebase/config.js` and replace the placeholder values with your Firebase Web App config.

## Firebase Realtime Database Rules
Upload: `js/firebase/rules.json` in Firebase Console → Realtime Database → Rules.

## Optional TURN
Edit: `js/webrtc/turn.js`
- set `enabled: true`
- fill `urls`, `username`, `credential`

## Run locally
Because this uses ES modules, run a local server:

```bash
python3 -m http.server 8080
```

Open http://localhost:8080

## Deploy to GitHub Pages
Push to GitHub, then Settings → Pages → deploy from branch (root).
