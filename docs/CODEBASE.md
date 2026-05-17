# Baby Monitor — Codebase Reference

> Read this before making any change. It describes how every part of the app fits together.

---

## Overview

A single-page web app that turns two browser tabs (or two phones) into a baby monitor. One device runs the **Camera** role, one runs the **Monitor** role. Video and audio travel peer-to-peer via WebRTC; Firebase Realtime Database is used only for the brief signaling handshake (offer/answer/ICE candidates). No video ever touches the Firebase server.

---

## File Map

```
app.js        — All application logic (~1700 lines)
index.html    — DOM structure; 4 screen sections; Firebase CDN scripts
styles.css    — All styling (~950 lines); CSS custom properties; no framework
README.md     — One-line placeholder
docs/
  CODEBASE.md — This file
```

---

## Technology Stack

| Concern | Choice |
|---|---|
| Video/audio transport | WebRTC (`RTCPeerConnection`) |
| Signaling | Firebase Realtime Database (compat SDK v9.22.2) |
| Auth | Firebase Anonymous Auth (required by security rules) |
| ICE | Google STUN servers (no TURN configured) |
| Audio synthesis | Web Audio API |
| Styling | Vanilla CSS with CSS custom properties |
| Scripting | Vanilla JS (no bundler, no framework) |

---

## Screen Architecture

The app has four screens, all present in the DOM simultaneously. Navigation is a push/pop stack with CSS slide transitions — it mimics iOS native-app navigation.

### Screens

| ID | Role | Enters via |
|---|---|---|
| `screen-home` | Landing page — choose Camera or Monitor | `data-root` (always visible at start) |
| `screen-camera` | Camera device: shows preview + room code | `openCamera()` |
| `screen-monitor` | Monitor device: numpad to enter room code | `openMonitor()` |
| `screen-live` | Monitor device: live video + controls | `joinRoom()` after code lookup |

### Navigation (`nav` IIFE, `app.js:87`)

The `nav` object manages a `stack[]` of screen IDs.

- **`nav.push(id, onEnter?)`** — slides the new screen in, pushes to `history`, calls `onEnter` after animation (320 ms).
- **`nav._popDom()`** — internal; strips `.active` from the leaving screen, restores `.active` on the previous one.
- **`popstate` listener** — when the browser back button fires, calls `teardownSession()` if a session is active, then pops the DOM.

CSS classes drive all transitions:
- `.active` → `translateX(0)` — on stage
- `.under` → `translateX(-14%) brightness(.92)` — pushed behind
- Default → `translateX(100%)` — off screen to the right
- `[data-root]` → `translateX(0)` always (home screen)

---

## WebRTC Connection Flow

### 1. Camera side (`startCamera`, `app.js:446`)

1. `getUserMedia` acquires video + audio with `facingMode: environment`.
2. An `RTCPeerConnection` is created with Google STUN.
3. A `DataChannel` named `ctrl` is created (camera is always the offerer).
4. Tracks from `localStream` are added to the peer connection.
5. ICE candidates are gathered. When `iceGatheringState === 'complete'`, the offer + all candidates are bundled into one object and written to `rooms/<code>/offer` in Firebase.
6. The 4-digit room code is displayed to the user.
7. A Firebase listener watches `rooms/<code>/answer`; when the monitor writes an answer, `setRemoteDescription` + `addIceCandidate` are called.

### 2. Monitor side (`joinRoom` → `createAnswerFromOffer`, `app.js:909`)

1. The monitor reads the 4-digit code from the numpad.
2. Firebase lookup: `rooms/<code>/offer`. If missing, shows error.
3. Navigates to `screen-live`, calls `createAnswerFromOffer`.
4. Creates `RTCPeerConnection`, requests mic access (added as a muted track for talk-back).
5. Sets remote description + candidates from the offer.
6. Creates an answer, gathers ICE, then writes `rooms/<code>/answer` to Firebase.
7. Camera's answer listener fires → both sides connected.

### Room cleanup

`teardownSession()` (`app.js:230`) calls `db.ref('rooms/' + currentRoomCode).remove()`. It also resets all state: closes `pc`, stops all tracks, clears timers, resets UI. Called on page hide and on browser back.

---

## Data Channel (`ctrl`) Messages

All messages are JSON. The camera creates the data channel; the monitor receives it via `ondatachannel`.

| `action` | Direction | Payload | Effect |
|---|---|---|---|
| `ping` | Monitor → Camera | — | Camera replies `{ action: 'ready' }` |
| `ready` | Camera → Monitor | — | Monitor enables live controls, hides overlay |
| `play` | Monitor → Camera | `{ sound: string }` | Camera plays lullaby / white noise / rain |
| `stop` | Monitor → Camera | — | Camera stops all audio |
| `request_cameras` | Monitor → Camera | — | Camera replies with available cameras |
| `cameras` | Camera → Monitor | `{ options, active }` | Monitor populates camera picker |
| `select_camera` | Monitor → Camera | `{ id: deviceId }` | Camera switches active lens |
| `motion` | Camera → Monitor | `{ ts }` | Monitor triggers motion alert |
| `motion_config` | Monitor → Camera | `{ enabled, cols, rows, mask[] }` | Camera updates detection zone + on/off |
| `motion_suspend` | Monitor → Camera | `{ suspended: bool }` | Camera pauses/resumes detection loop |

The monitor sends `motion_config` immediately when the data channel opens (after a 150 ms delay to let the connection stabilize), and again whenever the user changes zones or the toggle.

---

## Motion Detection (`startMotionDetection`, `app.js:705`)

Runs on the **camera** device, on the local video preview element. Returns a stop function.

### Algorithm

1. Downscales each video frame to **120×90** pixels via a hidden `<canvas>`.
2. Compares the red channel of each pixel against the previous frame.
3. Applies **global-mean-shift correction** (two-pass): computes mean red-channel delta across all tracked pixels (pass 1), then subtracts that mean from each pixel's delta (pass 2). This cancels uniform brightness drift from autoexposure or IR gain changes — only pixels that moved *relative to the rest of the frame* count.
4. A pixel counts as "changed" if its corrected delta exceeds `perPixelDelta` (default 25, range 0–255).
5. An alert fires only when `changedPixels / trackedPixels >= minAreaFrac` (default 2%) **and** this condition holds for `sustainedFrames` (default 2) **consecutive** frames, **and** `cooldownMs` (default 8 s) has elapsed since the last alert.

### Zone mask

- The monitor holds `zoneMaskMonitor`: `Array<boolean>` of length 48 (6 cols × 8 rows).
- `true` = track this cell; `false` = ignore.
- Sent to camera as `motion_config`. Camera stores as `zoneMaskCamera: { cols, rows, mask }`.
- During mask evaluation, pixels are mapped to cells by `cellW = 120/6`, `cellH = 90/8`.
- If `activeCells === 0`, detection is skipped for that frame.
- If `activeCells === total` (all selected), the fast path skips the per-pixel cell lookup.
- Persisted to `localStorage` under key `bm_zone_mask_v1`.

### Enable flag

- `motionEnabledMonitor` (boolean) persisted to `localStorage` under key `bm_motion_enabled_v1`.
- Sent as `enabled` in `motion_config`.
- Camera reads it as `motionEnabledCamera`; when `false`, the detection loop resets `last` and `hotStreak` each tick and skips processing.
- `motionSuspendedCamera` is a transient flag set while the zones overlay is open; prevents false alerts while the user is painting zones.

---

## Camera Enumeration (`enumerateCamerasClassified`, `app.js:407`)

After `getUserMedia` succeeds (labels are now available):

1. Filters to `videoinput` devices, then excludes front-facing cameras (label matches `front|selfie|facetime|user`).
2. Classifies each remaining camera as `'wide'` (matches `ultra-wide|ultrawide|0.5x|…`) or `'standard'` (everything else).
   - Deliberately does **not** match bare "wide" — "Back Dual Wide Camera" on iOS refers to the main sensor, not the ultra-wide.
3. Picks at most one `standard` and one `wide` entry (first of each kind).
4. Falls back to all cameras if no rear cameras found, and to one entry if classification yields nothing.

Camera switching (`switchCameraTo`, `app.js:621`) stops the old video tracks first (mobile constraint), opens a new stream, composes a new `MediaStream` with the new video + old audio, swaps the preview's `srcObject`, and replaces the sender track via `replaceTrack` — no renegotiation needed.

---

## Signal Strength Polling (`startStatsPolling`, `app.js:1137`)

Runs on the **monitor** side every 1.5 s once ICE connects.

1. Calls `pc.getStats()`, finds the `inbound-rtp` report with `kind === 'video'` (falls back to `mediaType` for older Safari).
2. Computes delta packets lost/received since last tick.
3. Scores 1–4 bars:
   - 4 bars: loss < 2%, jitter < 40 ms
   - 3 bars: loss < 5%, jitter < 70 ms
   - 2 bars: loss < 10%, jitter < 120 ms
   - 1 bar: anything worse, or zero packets received

The `signalBars` element in the HTML uses `data-strength` (0–4) to drive CSS bar highlighting.

---

## Audio System

### Camera-side sounds (`app.js:1589`)

All sounds use a single Web Audio `AudioContext` (`audioCtx`) → `GainNode` (`gain`, value 0.28) → destination.

| Sound | Implementation |
|---|---|
| `lullaby1` | "Twinkle Twinkle" — 14-note frequency array, sine oscillator, looping with `playMelody` |
| `lullaby2` | Brahms-style — 10-note array, same engine |
| `whitenoise` | 2-second random buffer, looping `AudioBufferSourceNode` |
| `rain` | Same as white noise at 50% amplitude, passed through a 900 Hz lowpass filter |

`stopSoundOnCamera` cancels the active oscillator or buffer source and clears the melody timer.

### Monitor-side alerts (`app.js:1402`)

Uses a separate `AudioContext` (`notifyCtx`). Resumed lazily on first use.

| Alert | Pattern |
|---|---|
| Motion detected | 4-tone ascending chirp: G5 → B5 → D6 → E6 (sine, 140 ms each) |
| Connection lost | Repeating every 1.5 s: two alternating square-wave tones + descending sine resolve |

`makeBeep(ctx, freq, startOffset, duration, volume, type)` schedules a single tone using `linearRampToValueAtTime` / `exponentialRampToValueAtTime` for smooth attack/release.

---

## Push-to-Talk (`app.js:1561`)

- The monitor's microphone is acquired with `getUserMedia` in `createAnswerFromOffer`, added as a track to the peer connection, and **immediately muted** (`track.enabled = false`).
- The `micBtn` FAB uses `pointerdown`/`pointerup`/`pointerleave`/`pointercancel` + `touchstart`/`touchend` to call `startTalking()` / `stopTalking()`, which toggle `monitorMicTrack.enabled`.
- The camera receives the talk-back audio via `pc.ontrack` (kind `audio`) and plays it through `<audio id="remoteAudio">`.

---

## Live Session Timer (`app.js:1516`)

Displayed in the Live screen app-bar title (`liveAppBarTitle`). Starts when the ICE or connection state reaches `connected`/`completed` (whichever fires first — both `onconnectionstatechange` and `oniceconnectionstatechange` call `startLiveTimer()`, which is idempotent). Ticks every 1 s, formats as `HH:MM:SS`. Stops and resets on `teardownSession`.

---

## Global State Variables (`app.js:33`)

### Session (both roles)
| Variable | Type | Purpose |
|---|---|---|
| `pc` | `RTCPeerConnection\|null` | Active peer connection |
| `localStream` | `MediaStream\|null` | Camera's local camera+mic stream |
| `cameraAudioTrack` | `MediaStreamTrack\|null` | Camera's mic track |
| `monitorMicStream` | `MediaStream\|null` | Monitor's mic stream |
| `monitorMicTrack` | `MediaStreamTrack\|null` | Monitor's mic track (toggled for PTT) |
| `dataChannel` | `RTCDataChannel\|null` | The `ctrl` channel |
| `pingTimer` | `number\|null` | `setInterval` ID for 800 ms pings |
| `currentRoomCode` | `string\|null` | Active 4-digit room code |
| `answerListenerRef` | Firebase ref | Camera's Firebase answer listener |

### Camera-only
| Variable | Purpose |
|---|---|
| `motionStop` | Function that clears the motion detection interval |
| `availableCameras` | `[{id, label, kind}]` from enumeration |
| `activeCameraId` | `deviceId` of the current video track |
| `audioCtx`, `gain`, `currentOsc`, `currentSrc` | Web Audio graph for sounds |
| `melodyTimer`, `melodyActive` | Melody loop state |
| `zoneMaskCamera` | `{cols, rows, mask[]}` received from monitor |
| `motionEnabledCamera` | Boolean received from monitor |
| `motionSuspendedCamera` | Transient: true while zones overlay is open |

### Monitor-only
| Variable | Purpose |
|---|---|
| `statsTimer` | `setInterval` ID for signal strength polling |
| `notifyCtx` | Web Audio context for alert beeps |
| `connLostTimer` | `setInterval` ID for repeating connection-lost beep |
| `wasEverConnected` | Guards against false "connection lost" alerts during initial setup |
| `liveTimerStartMs`, `liveTimerInterval` | Session elapsed timer |
| `zoneMaskMonitor` | `Array<boolean>` length 48, source of truth for zones |
| `motionEnabledMonitor` | Boolean, source of truth for motion on/off |
| `pinDigits`, `joinInFlight` | Numpad state |

---

## CSS Design System (`styles.css`)

### CSS Custom Properties (`:root`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#eef1f7` | Page background |
| `--surface` | `#ffffff` | Cards, buttons |
| `--surface-2` | `#f6f8fc` | Screen background, input fields |
| `--surface-3` | `#e9edf5` | Active state backgrounds |
| `--text` | `#141a2c` | Primary text |
| `--text-muted` | `#626b80` | Secondary text, labels |
| `--text-faint` | `#8c93a5` | Placeholder dots, chevrons |
| `--accent` | `#4f6df5` | Primary interactive color |
| `--success` | `#16a34a` | Connected state, motion banner |
| `--danger` | `#dc2626` | Error state, connection lost |
| `--app-bar-h` | `52px` | App bar height (+ safe-top on iOS) |
| `--radius` / `--radius-lg` / `--radius-xl` | `14px` / `18px` / `22px` | Border radii |
| `--safe-*` | `env(safe-area-inset-*)` | iOS notch/home bar clearance |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | Navigation slide easing |
| `--dur` | `.32s` | Navigation animation duration |

### Breakpoints

| Query | Effect |
|---|---|
| `min-width: 720px` | App centered in a 420×820 px phone-shaped frame on desktop |
| `min-width: 720px` + `max-height: 720px` | Shorter frame on landscape desktop |
| `max-width: 360px` | Smaller numpad / pin cells / room code text for tiny phones |

### Notable CSS Patterns

- **Screen stack**: `.screen` always off-screen right; `.active` on-screen; `.under` 14% left + dimmed; `[data-root]` always at 0. All transitions use `--dur` / `--ease`.
- **Signal bars**: `data-strength` attribute (0–4) on `.signal-bars`; CSS attribute selectors light the first N bars and color them (red → yellow → green).
- **Connection dot**: `data-state` attribute (`idle|pending|live|error`) drives color + pulsing animation.
- **Motion flash**: `.motion-flash::after` on `.live-video` adds a green overlay; `.motion-banner.flash` animates a pill chip. Both use `@keyframes` that flash 3× over 2.4 s.
- **Connection lost**: `.connection-lost::before` adds a steady red tint; `.connection-lost .video-overlay` darkens the overlay text.
- **Zones grid**: `display: grid; grid-template-columns: repeat(6, 1fr); grid-template-rows: repeat(8, 1fr)`. Selected cells get a green tint + brighter border.
- **App bar**: `backdrop-filter: saturate(180%) blur(18px)` for frosted-glass effect.

---

## Firebase Configuration (`app.js:8`)

- **Project**: `baby-monitor-b862d`
- **Database URL**: `https://baby-monitor-b862d-default-rtdb.firebaseio.com/`
- **Auth**: Anonymous sign-in (required for database access).
- **Data structure**:
  ```
  rooms/
    <4-digit-code>/
      offer:   { sdp: {type, sdp}, candidates: [...] }
      answer:  { sdp: {type, sdp}, candidates: [...] }
  ```
- Room node is deleted by the camera in `teardownSession`. It is also deleted on page hide.
- The Firebase SDK is loaded from Google's CDN as the compat (v8-style API) bundle, not the modular v9 API.

---

## Key Behaviors & Edge Cases

- **iOS Safari ICE fallback**: Both `onconnectionstatechange` and `oniceconnectionstatechange` trigger the "connected" path independently. All connected-state functions (`startLiveTimer`, `hideLiveOverlay`, `startStatsPolling`) are idempotent so double-firing is safe.
- **iOS autoplay**: `monitorVideo.play()` is called explicitly and retried on `loadedmetadata` because iOS Safari sometimes ignores `autoplay` on a WebRTC stream that arrives slightly after the user gesture.
- **No aspect-ratio constraint on camera**: Forcing 9:16 or a square on iOS causes ~25% FOV crop or pipeline failures on older devices. The native sensor frame (typically 4:3) is sent as-is; the monitor uses `object-fit: cover` to fill.
- **Camera switching**: Old video tracks must be stopped before opening the new camera — mobile browsers refuse to open a second camera while one is still active.
- **Zone drag on iOS**: Pointer Events can drop reliability after leaving the original child on iOS Safari. The zone paint gesture listens on `document` during the gesture, and registers both Pointer Events and Touch Events with an `activeGesture` source guard to prevent double-dispatch.
- **Ping handshake**: The monitor sends `ping` every 800 ms until the camera's `ready` reply arrives. This ensures the data channel is open before enabling live controls, as `onconnectionstatechange` can fire slightly before `dataChannel.readyState` becomes `'open'`.
- **Motion suspend during zone editing**: When the zones overlay opens, the monitor sends `motion_suspend: true` to the camera. The detection loop resets `last` + `hotStreak` while suspended, so there are no stale-frame false positives on resume.
