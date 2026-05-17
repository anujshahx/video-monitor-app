# Feature & Change Tracker

Status legend: `[ ]` pending · `[~]` in progress · `[x]` done

Free = available to all users · **Premium** = gated behind a paid tier

---

## Free Features

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Sign-up / login page (Google + Apple) | `[ ]` | Firebase Auth — Google provider + Sign in with Apple. Shown before Home screen on first launch. |
| 2 | Same-wifi check on connect | `[ ]` | Browsers block direct SSID access. Best approximation: compare local IP prefixes via WebRTC ICE candidates (e.g. `192.168.1.x` vs `192.168.1.y`). Shows a **warning banner only** — never a hard block. Silently passes if check is inconclusive. |
| 7 | UI overhaul — fullscreen monitor + overlay controls | `[ ]` | Monitor live view goes fullscreen; mic/sound/camera controls become floating overlays on the video. Camera screen: shrink preview, black background. |
| 8 | Analytics (Google Analytics or free alternative) | `[ ]` | Add GA4 snippet to `index.html`. Track: screen views, session start/end, motion events, connection quality. |
| 16 | Pinch-to-zoom on monitor live view | `[ ]` | CSS `touch-action` + pointer event scale gesture on `#monitorVideo`. |
| 17 | Share button + popup with app URL | `[ ]` | Web Share API (`navigator.share`) with fallback copy-to-clipboard modal. URL to share will be set once app is deployed (#9). Placeholder until then. |
| 18 | Reviews + session count on home screen | `[ ]` | User-submitted reviews stored in Firestore. Global session counter ("Monitored X baby sessions") aggregated across all users, stored in Firestore. |

---

## Premium Features

| # | Feature | Status | Notes |
|---|---|---|---|
| 3 | More soothing sounds | `[ ]` | Source: freesound.org (CC0), NASA audio, or procedurally generated (Web Audio — zero storage). Candidates: ocean waves, heartbeat, fan hum. Will evaluate per sound. |
| 4 | Activity profile — sessions + motion timeline | `[ ]` | Per-user session log: start/end time, motion events with timestamps. Stored in Firebase Firestore (per UID). Requires #1 (auth) and #9 (server). |
| 5 | Capture photo / video from monitor + lightweight AI | `[ ]` | Photo: `canvas.toBlob` from video frame. Video: `MediaRecorder` on the WebRTC stream. AI: TensorFlow.js client-side (no server cost) for motion events, face detection, and baby posture (on back vs stomach). No cloud API needed. |
| 6 | SD default + HD option | `[ ]` | Camera constraints: SD = `{ width: 640, height: 480 }`; HD = `{ width: 1280, height: 720 }`. Toggle sent via data channel `video_quality` action; camera re-acquires stream with new constraints. |
| 9 | Move to Firebase hosting + Functions (replace pure client-side) | `[ ]` | **Decision: Firebase.** Firebase Hosting for deployment, Firestore for structured data (sessions, reviews), Firebase Functions for premium gating + server logic, FCM for push notifications. All within existing Firebase project. Unblocks #4, #11, #12, #17, #18. |
| 10 | Picture-in-Picture (monitor continues in background) | `[ ]` | `document.pictureInPictureEnabled` + `videoEl.requestPictureInPicture()`. Supported on iOS 16+ Safari and all modern desktop browsers. |
| 11 | Push notifications when browser is closed (motion, connection lost, etc.) | `[ ]` | Requires a Service Worker + Web Push API + a push server (e.g. Firebase Cloud Messaging). Camera tab must remain open; monitor tab can be closed. |
| 12 | Detailed activity log page (inside sessions) | `[ ]` | Sub-page of #4: per-session timeline, motion event list with timestamps, session duration. Requires #4. |
| 13 | Dark mode on camera screen (premium gate) | `[ ]` | Dark mode CSS already partially present (black video background). Gate the toggle behind premium check. |
| 14 | Motion detection sensitivity levels | `[ ]` | 4 named levels controlling `perPixelDelta` + `minAreaFrac` in `startMotionDetection`: **Whisper** (lowest) · **Gentle** · **Active** · **Alert** (highest). Default = Gentle. |
| 15 | Camera lens switching from monitor (premium gate) | `[ ]` | `select_camera` data channel message already implemented — just gate the camera picker UI behind premium check. |

---

## Decisions Log

| # | Question | Decision |
|---|---|---|
| Q1 | Same-wifi check: hard block or warning? | Warning only; silently pass if inconclusive |
| Q2 | Share button URL: deployed or placeholder? | Placeholder until #9 (Firebase Hosting) is live |
| Q3 | Reviews: source + session count scope? | User-submitted; global count across all users |
| Q4 | AI for #5: what to detect? | Motion events, face detection, baby posture (back vs stomach) — TensorFlow.js client-side |
| Q5 | Server: Firebase or separate? | **Firebase** — Hosting + Functions + Firestore + FCM |
| Q6 | Motion level names? | **Whisper · Gentle · Active · Alert** — default = Gentle |

---

## Implementation Order (Suggested)

```
Phase 1 — Foundation
  #1  Auth (blocks premium gating everywhere)
  #8  Analytics (low effort, high value early)
  #9  Server decision (unblocks #4, #11, #12)

Phase 2 — Core UX
  #7  UI overhaul
  #2  Same-wifi check
  #17 Share button
  #16 Pinch-to-zoom

Phase 3 — Free polish
  #18 Reviews + session count
  #6  SD/HD toggle (premium)
  #15 Camera switching gate (premium)
  #14 Motion sensitivity levels (premium)
  #13 Dark mode gate (premium)

Phase 4 — Premium features
  #3  Premium sounds
  #4  Activity profile + sessions
  #12 Activity log detail page
  #10 Picture-in-Picture
  #5  Photo/video capture + AI
  #11 Push notifications
```
