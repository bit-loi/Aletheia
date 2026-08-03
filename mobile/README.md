# Aletheia Mobile

Real-time misinformation verification for TikTok, Instagram Reels, and YouTube — powered by the same verification pipeline as the Aletheia browser extension.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  User hears a suspicious claim on TikTok / IG / YouTube │
│                                                         │
│  1. Open Aletheia → enable the floating widget, or tap  │
│     START AUTO FACT CHECK                               │
│  2. Switch back to the social media app                 │
│  3. Audio plays through phone speaker                   │
│  4. Phone mic captures it in 15-second windows          │
│  5. The mic stays open — windows keep coming            │
│  6. Audio → Gemini batch transcription → transcript     │
│  7. Transcript → claim extraction → evidence search     │
│     → grounded verdict (True/False/Misleading/Unverified)│
│  8. Each verdict appears in the floating card as it     │
│     lands, while the next window is already recording   │
└─────────────────────────────────────────────────────────┘
```

### Auto-listen

Like the desktop extension, mobile starts once and keeps going: the native
recorder holds a single `AudioRecord` open and emits a finished WAV every 15
seconds, so the next window is captured while the previous one is still in
transcription. It is not a JS loop over the one-shot path — that would leave
the microphone closed for the whole round trip (missing most of what plays),
and restarting a foreground service from inside TikTok hits the Android 12+
background-start restriction.

Two things keep a continuous run from burning the shared quota:

- windows that transcribe to silence, or to the same text as the previous
  window, are never sent on to claim extraction;
- claims already checked in the run are skipped before any search or verdict
  call, which is why auto-listen uses the per-claim path rather than
  `/v1/verify-mobile`.

Three consecutive failed windows stop the run and surface the reason rather
than looping against a broken proxy. Stop manually from the in-app button or
the "STOP LISTENING" action on the recording notification.

### Architecture

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────┐
│   Mobile App │────▶│  Cloudflare Worker   │────▶│  Gemini API  │
│  (React Native)│   │  (proxy/src/index.js)│     │  Tavily API  │
│              │     │                      │     │  Wikipedia   │
│  audioCapture│     │  Bearer token auth   │     └──────────────┘
│  transcribe  │     │  LLM provider chain  │
│  verifyContent│    │  Search provider chain│
└──────────────┘     └──────────────────────┘
```

**Same pipeline as the extension.** The mobile `verifyContent.ts` is a direct port of the extension's `modules/pipeline.js` — identical prompts, identical claim extraction, identical verdict logic. The only difference is the audio source (microphone instead of tab capture) and the transcription method (Gemini batch instead of Gemini Live streaming).

## Quick Start (Android)

### Prerequisites
- Node.js 22.11+ (enforced by `engines` in package.json — React Native 0.86 needs it)
- Android Studio with SDK installed, and `ANDROID_HOME` exported
- Physical Android device (USB debugging enabled) or emulator
- `adb` in your PATH

### Setup

```bash
cd mobile

# Install dependencies
npm install

# Create the local secrets file. It is gitignored: nothing in this directory
# should ever hold a real credential.
cp src/config.env.example.ts src/config.env.ts

# Generate a token and give the SAME value to both sides.
openssl rand -hex 32          # paste into MOBILE_API_TOKEN in src/config.env.ts

cd ../proxy
npx wrangler secret put MOBILE_API_TOKEN   # paste the same value
npx wrangler deploy                        # the app 403s until this is deployed

# Run on Android
cd ../mobile
npx react-native run-android
```

The token must match character-for-character or every request comes back
`403 {"error":"origin not allowed"}`.

### First Run
1. App opens with a **START AUTO FACT CHECK** button
2. Grant microphone permission when prompted
3. If headphones are connected, a warning banner appears — **unplug them**
4. Enable the floating widget (this also starts auto-listening), or tap the
   button, then switch to TikTok/YouTube
5. Audio plays through the phone speaker → microphone captures it
6. Verdict cards appear in the floating card as claims are checked; no further
   taps are needed
7. Stop from the in-app button or the notification's **STOP LISTENING** action

## Project Structure

```
mobile/
├── App.tsx                    # Main UI (Listen button + Results view)
├── src/
│   ├── config.ts              # Backend URLs, auth token, recording settings
│   ├── config.env.example.ts  # Template — copy to config.env.ts (gitignored)
│   ├── audioCapture.ts        # Microphone recording (wraps native module)
│   ├── transcribe.ts          # Batch audio→text via POST /v1/transcribe
│   ├── verifyContent.ts       # Port of pipeline.js (extractClaims→retrieveEvidence→generateVerdict)
│   ├── mergeContext.ts        # Combines audio transcript + OCR text (Phase 2)
│   ├── screenCapture.ts       # Screen recording for OCR (Phase 2 stub)
│   ├── ocrClient.ts           # PaddleOCR microservice client (Phase 2 stub)
│   └── useListenSession.ts    # React hook orchestrating the full flow
├── android/
│   └── app/src/main/
│       ├── AndroidManifest.xml              # Permissions + foreground service
│       └── java/com/aletheia/app/
│           ├── MainActivity.kt              # Standard RN activity
│           ├── MainApplication.kt           # Registers AudioRecorderPackage
│           ├── AudioRecorderService.kt      # Foreground service (mic recording)
│           ├── AudioRecorderModule.kt       # RN native module bridge
│           └── AudioRecorderPackage.kt      # Package registration
└── ios/
    └── AletheiaApp/
        └── Info.plist                       # Background audio mode + mic rationale
```

## Known Limitations

### 🎧 Headphones Break This

If wired headphones, Bluetooth earbuds, or AirPods are connected, audio from TikTok/YouTube plays directly to the headphones, **not** through the phone speaker. The phone's microphone cannot pick up anything useful.

**The app detects this** and shows a warning banner before you can tap Listen. Unplug headphones to use the app.

### 📱 Recording Must Start in the Foreground

The app **must** be in the foreground when you tap Listen. It cannot start microphone recording while backgrounded. Once recording has started, it continues in the background when you switch to TikTok/YouTube because:

- **Android:** The recording runs inside a foreground service with a mandatory persistent notification ("Aletheia is listening"). This is an OS requirement since Android 9, not optional.
- **iOS:** Requires `UIBackgroundModes: audio` in Info.plist and `AVAudioSession` recording started while foregrounded. **Untested on device.**

### 🍎 iOS: Designed but Unverified

The iOS code (Info.plist background mode, mic permission rationale) is written and included but has **not been tested on a physical device**. Testing requires:

- A Mac running macOS
- Xcode installed
- An active Apple Developer account
- A physical iPhone (Simulator does not support microphone input from external audio)

**iOS 18 Caveat:** Apple's own ShazamKit has been observed to stop receiving matches in the background after ~20 seconds on iOS 18 (works on iOS 17). The recording window is kept at 15 seconds to stay under this threshold.

### 🔇 Two Apps Can't Share the Microphone

TikTok does not use the microphone during normal video playback, so this is not a practical issue. But if the user is also on a phone call, video chat, or another app that holds the microphone, Aletheia's recording will fail.

### 📊 Phase 2: Screen Capture + OCR (Not Yet Built)

The `screenCapture.ts`, `ocrClient.ts`, and `mergeContext.ts` modules exist as documented stubs. The full multimodal pipeline (audio + on-screen text) requires:

- `MediaProjection` setup on Android (separate service, separate permission flow)
- `RPScreenRecorder` setup on iOS
- A standalone PaddleOCR FastAPI microservice
- The screen recording indicator (red status bar on iOS, persistent notification on Android) is mandatory OS behavior

This is Phase 2 scope and was descoped to ship the core audio-only demo first.

## Worker Changes

The Cloudflare Worker (`proxy/src/index.js`) was updated to accept mobile clients:

```
# Set the mobile API token as a Cloudflare secret:
npx wrangler secret put MOBILE_API_TOKEN
```

Mobile clients authenticate via `Authorization: Bearer <token>` header instead of the Chrome extension's `Origin` header (which React Native's `fetch()` does not send).

The existing Chrome extension path is completely unchanged — the Worker checks for a valid bearer token only if the origin check fails.

### Endpoints the app uses

| Endpoint | Called by | Purpose |
|---|---|---|
| `POST /v1/transcribe` | `transcribe.ts` | base64 audio clip → transcript |
| `POST /v1/verify-mobile` | `verifyContent.ts` | transcript → claims → evidence → verdict, in one round trip |
| `POST /v1/chat`, `POST /v1/search` | `verifyContent.ts` | step-by-step fallback if `/v1/verify-mobile` fails |

`/v1/transcribe` exists because audio cannot go through `/v1/chat`: that route
speaks the OpenAI-compatible chat shape, which has no audio surface on Gemini,
and its 128 KB body cap is far below the ~640 KB a 15 s clip base64s to. The
transcribe route calls Gemini's native `generateContent` with `inline_data` and
carries its own 2 MB cap.

## Interview Talking Points

### Architecture Choice: Microphone-Based Capture

> "We chose microphone-based ambient capture over Share Sheet or Accessibility Service because it works identically on both Android and iOS. Microphone access is a standard permission on both platforms, unlike AccessibilityService (Android-only, raises Play Store review flags) or Share Extensions (iOS-only, requires heavy Xcode/native setup). The user taps Listen in Aletheia, switches to TikTok, and the phone's microphone picks up the audio playing through the speaker. This is the same fundamental approach Shazam uses."

### Known Limitations (Be Honest About These)

> "The main limitation is headphones — if the user is wearing AirPods or any headphones, the audio goes to their ears, not the speaker, so the microphone can't pick it up. We detect this and warn the user upfront rather than silently failing. On iOS 18, Apple's own ShazamKit has a known bug where background audio processing stops after ~20 seconds, so we keep our recording window at 15 seconds. And the iOS path is designed but untested on-device because we don't have a Mac and Apple Developer account available."

### Pipeline Reuse

> "The verification pipeline is a direct port of the browser extension's pipeline.js — identical prompts, identical claim extraction logic, identical verdict generation. The only things that changed are the audio source (microphone instead of Chrome's tabCapture API) and the authentication (bearer token instead of Chrome extension origin). The pipeline calls go through the same Cloudflare Worker proxy, which handles LLM provider failover across Gemini, OpenRouter, and Groq."

## License

Same as the main Aletheia project. See the root LICENSE file.
