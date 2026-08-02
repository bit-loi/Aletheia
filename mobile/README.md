# Aletheia Mobile

Real-time misinformation verification for TikTok, Instagram Reels, and YouTube — powered by the same verification pipeline as the Aletheia browser extension.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  User hears a suspicious claim on TikTok / IG / YouTube │
│                                                         │
│  1. Open Aletheia → tap the Listen button               │
│  2. Switch back to the social media app                 │
│  3. Audio plays through phone speaker                   │
│  4. Phone mic captures it (15 seconds)                  │
│  5. Recording auto-stops                                │
│  6. Audio → Gemini batch transcription → transcript     │
│  7. Transcript → claim extraction → evidence search     │
│     → grounded verdict (True/False/Misleading/Unverified)│
│  8. Results shown when user returns to Aletheia         │
└─────────────────────────────────────────────────────────┘
```

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
- Node.js 20+
- Android Studio with SDK installed
- Physical Android device (USB debugging enabled) or emulator
- `adb` in your PATH

### Setup

```bash
cd mobile

# Install dependencies
npm install

# Set your mobile API token in src/config.ts
# (or set MOBILE_API_TOKEN env var before building)

# Deploy the Worker with the mobile token secret:
cd ../proxy
npx wrangler secret put MOBILE_API_TOKEN
# Enter a random string when prompted

# Run on Android
cd ../mobile
npx react-native run-android
```

### First Run
1. App opens with a **Listen** button
2. Grant microphone permission when prompted
3. If headphones are connected, a warning banner appears — **unplug them**
4. Tap **Listen**, then switch to TikTok/YouTube
5. Audio plays through the phone speaker → microphone captures it
6. After 15 seconds, recording stops automatically
7. The app transcribes and verifies in the background
8. Return to Aletheia to see the results

## Project Structure

```
mobile/
├── App.tsx                    # Main UI (Listen button + Results view)
├── src/
│   ├── config.ts              # Backend URLs, auth token, recording settings
│   ├── audioCapture.ts        # Microphone recording (wraps native module)
│   ├── transcribe.ts          # Batch audio→text via Gemini (through proxy)
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

## Interview Talking Points

### Architecture Choice: Microphone-Based Capture

> "We chose microphone-based ambient capture over Share Sheet or Accessibility Service because it works identically on both Android and iOS. Microphone access is a standard permission on both platforms, unlike AccessibilityService (Android-only, raises Play Store review flags) or Share Extensions (iOS-only, requires heavy Xcode/native setup). The user taps Listen in Aletheia, switches to TikTok, and the phone's microphone picks up the audio playing through the speaker. This is the same fundamental approach Shazam uses."

### Known Limitations (Be Honest About These)

> "The main limitation is headphones — if the user is wearing AirPods or any headphones, the audio goes to their ears, not the speaker, so the microphone can't pick it up. We detect this and warn the user upfront rather than silently failing. On iOS 18, Apple's own ShazamKit has a known bug where background audio processing stops after ~20 seconds, so we keep our recording window at 15 seconds. And the iOS path is designed but untested on-device because we don't have a Mac and Apple Developer account available."

### Pipeline Reuse

> "The verification pipeline is a direct port of the browser extension's pipeline.js — identical prompts, identical claim extraction logic, identical verdict generation. The only things that changed are the audio source (microphone instead of Chrome's tabCapture API) and the authentication (bearer token instead of Chrome extension origin). The pipeline calls go through the same Cloudflare Worker proxy, which handles LLM provider failover across Gemini, OpenRouter, and Groq."

## License

Same as the main Aletheia project. See the root LICENSE file.
