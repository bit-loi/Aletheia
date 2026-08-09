/**
 * audioCapture.ts: The ONLY module that handles microphone recording.
 *
 * Mirrors the audio capture responsibility of the extension's offscreen.js,
 * but uses React Native's audio APIs instead of Chrome's tabCapture.
 *
 * Key design decisions:
 *   - Records to a local WAV file (not streamed), since mobile uses batch
 *     transcription rather than Gemini Live streaming.
 *   - Auto-stops after CONFIG.MAX_RECORD_DURATION_MS (15s default).
 *   - On Android, recording is done inside a foreground service so it
 *     survives app backgrounding (see android/ForegroundService).
 *   - On iOS, uses AVAudioSession with "audio" background mode declared
 *     in Info.plist (untested — requires Mac + Xcode + Apple Developer account).
 */

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { CONFIG } from './config';

const { AudioRecorderModule, OverlayPermissionModule } = NativeModules;

export type RecordingState = 'idle' | 'recording' | 'processing' | 'error';

interface RecordingCallbacks {
  onStateChange: (state: RecordingState) => void;
  onError: (error: string) => void;
  onComplete: (filePath: string) => void;
  onAmplitude?: (amplitude: number) => void;
}

let currentCallbacks: RecordingCallbacks | null = null;
let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
let emitterSubscription: any = null;

function clearOneShotResources(): void {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }
  emitterSubscription?.remove();
  emitterSubscription = null;
}

function completeOneShot(filePath: string): void {
  const callbacks = currentCallbacks;
  if (!callbacks) return;
  currentCallbacks = null;
  clearOneShotResources();
  callbacks.onStateChange('processing');
  callbacks.onComplete(filePath);
}

function failOneShot(message: string): void {
  const callbacks = currentCallbacks;
  if (!callbacks) return;
  currentCallbacks = null;
  clearOneShotResources();
  callbacks.onStateChange('error');
  callbacks.onError(message);
}

/**
 * Start microphone recording.
 *
 * MUST be called while the app is in the foreground. The recording will
 * continue when the user switches to another app (TikTok, YouTube, etc.)
 * because:
 *   - Android: runs inside a foreground service with persistent notification
 *   - iOS: AVAudioSession with "audio" UIBackgroundMode (untested)
 *
 * Auto-stops after CONFIG.MAX_RECORD_DURATION_MS.
 */
export async function startRecording(callbacks: RecordingCallbacks): Promise<void> {
  if (currentCallbacks) {
    throw new Error('A recording is already in progress.');
  }

  currentCallbacks = callbacks;
  callbacks.onStateChange('recording');

  // Subscribe before asking native code to start. The native promise resolves
  // only when recording finishes; awaiting it here used to install this
  // listener and the safety timer after the audio had already been captured.
  if (AudioRecorderModule.addListener) {
    const emitter = new NativeEventEmitter(AudioRecorderModule);
    emitterSubscription = emitter.addListener('onAmplitude', (event) => {
      currentCallbacks?.onAmplitude?.(event.amplitude);
    });
  }

  autoStopTimer = setTimeout(() => {
    stopRecording();
  }, CONFIG.MAX_RECORD_DURATION_MS + 1000);

  try {
    const recordingPromise: Promise<string> = AudioRecorderModule.startRecording({
      maxDurationMs: CONFIG.MAX_RECORD_DURATION_MS,
      sampleRate: 16000,
      channels: 1,
      encoding: 'pcm_16bit',
      outputFormat: 'wav',
    });
    recordingPromise
      .then((filePath) => completeOneShot(filePath))
      .catch((err: Error) => failOneShot(`Failed to record audio: ${err.message}`));
  } catch (err: any) {
    failOneShot(`Failed to start recording: ${err.message}`);
  }
}

/**
 * Stop the current recording and return the file path.
 */
export async function stopRecording(): Promise<string | null> {
  if (!currentCallbacks) {
    return null;
  }

  try {
    const filePath: string = await AudioRecorderModule.stopRecording();
    completeOneShot(filePath);
    return filePath;
  } catch (err: any) {
    failOneShot(`Failed to stop recording: ${err.message}`);
    return null;
  }
}

/**
 * Check if a recording is currently in progress.
 */
export function isRecording(): boolean {
  return currentCallbacks !== null;
}

// ─── Continuous (auto-listen) capture ────────────────────────────────────────

interface ContinuousCallbacks {
  /** Fired once per finished window, with the path to its WAV file. */
  onChunk: (filePath: string) => void;
  onError: (error: string) => void;
  onAmplitude?: (amplitude: number) => void;
}

let continuousCallbacks: ContinuousCallbacks | null = null;
let chunkSubscription: any = null;
let continuousAmplitudeSubscription: any = null;
let continuousErrorSubscription: any = null;

/**
 * Start auto-listen: the microphone stays open and a finished WAV arrives
 * every CONFIG.MAX_RECORD_DURATION_MS, so the next window is already being
 * captured while the previous one is still being transcribed.
 *
 * This is the mobile equivalent of the extension's continuous tab-audio
 * capture — one start, then results keep coming until stopped.
 */
export async function startContinuousRecording(
  callbacks: ContinuousCallbacks,
): Promise<void> {
  if (continuousCallbacks) {
    throw new Error('Auto-listen is already running.');
  }

  continuousCallbacks = callbacks;

  const emitter = new NativeEventEmitter(AudioRecorderModule);
  chunkSubscription = emitter.addListener('onRecordingChunk', (event: {filePath: string}) => {
    if (event?.filePath) continuousCallbacks?.onChunk(event.filePath);
  });
  continuousAmplitudeSubscription = emitter.addListener('onAmplitude', (event) => {
    continuousCallbacks?.onAmplitude?.(event.amplitude);
  });
  continuousErrorSubscription = emitter.addListener('onRecordingError', (event) => {
    continuousCallbacks?.onError(event?.message || 'Audio recording failed.');
  });

  try {
    await AudioRecorderModule.startContinuousRecording({
      maxDurationMs: CONFIG.MAX_RECORD_DURATION_MS,
      sampleRate: 16000,
      channels: 1,
      encoding: 'pcm_16bit',
      outputFormat: 'wav',
    });
  } catch (err: any) {
    await stopContinuousRecording();
    callbacks.onError(`Failed to start auto-listen: ${err.message}`);
    throw err;
  }
}

/** Stop auto-listen. Safe to call when it is not running. */
export async function stopContinuousRecording(): Promise<void> {
  chunkSubscription?.remove();
  chunkSubscription = null;
  continuousAmplitudeSubscription?.remove();
  continuousAmplitudeSubscription = null;
  continuousErrorSubscription?.remove();
  continuousErrorSubscription = null;
  continuousCallbacks = null;

  try {
    await AudioRecorderModule.stopContinuousRecording();
  } catch (err) {
    console.warn('[Aletheia] Failed to stop native auto-listen service:', err);
  }
}

export function isContinuousRecording(): boolean {
  return continuousCallbacks !== null;
}

/** Drop a chunk file once its audio has been uploaded. */
export async function deleteRecording(filePath: string): Promise<void> {
  try {
    const deleted = await AudioRecorderModule.deleteRecording(filePath);
    if (!deleted) console.warn('[Aletheia] Recording file was not deleted:', filePath);
  } catch (err) {
    console.warn('[Aletheia] Failed to delete recording file:', err);
  }
}

/**
 * Check if headphones (wired or Bluetooth) are connected.
 *
 * When headphones are connected, TikTok/YouTube audio plays directly to the
 * headphones and the phone's microphone cannot pick it up. The UI should
 * show a warning before the user taps Listen.
 */
export async function isHeadphonesConnected(): Promise<boolean> {
  try {
    return await AudioRecorderModule.isHeadphonesConnected();
  } catch {
    // If the native module isn't available, assume no headphones
    // (better to attempt recording than to block it)
    return false;
  }
}

/**
 * Request microphone permission with a rationale.
 *
 * On Android, shows the system permission dialog with a brief explanation.
 * On iOS, triggers the permission prompt (rationale is in Info.plist).
 */
export async function requestMicrophonePermission(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      const { PermissionsAndroid } = require('react-native');
      const micGranted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Microphone Access',
          message:
            'Aletheia needs microphone access to listen to audio playing through ' +
            'your phone speaker and verify the claims being made.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        },
      );

      if (micGranted !== PermissionsAndroid.RESULTS.GRANTED) {
        return false;
      }

      if (Platform.Version >= 33 && PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          {
            title: 'Notification Access',
            message:
              'Aletheia needs notification permission to show background listening controls in your status bar.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          },
        );
      }

      return true;
    } else {
      return true;
    }
  } catch (err) {
    console.warn('[Aletheia] Permission request failed:', err);
    return false;
  }
}

/**
 * Floating widget integration — all through OverlayPermissionModule.
 *
 * The overlay permission flow is driven by the "Enable floating widget"
 * button in the app (not silently inside the microphone request), per the
 * widget build spec: open Settings → AppState listener → start service.
 */

export function updateWidgetStatus(text: string): void {
  if (Platform.OS === 'android' && OverlayPermissionModule?.updateWidgetStatus) {
    try {
      OverlayPermissionModule.updateWidgetStatus(text);
    } catch {}
  }
}

export function updateWidgetVerdict(verdictJson: string): void {
  if (Platform.OS === 'android' && OverlayPermissionModule?.updateWidgetVerdict) {
    try {
      OverlayPermissionModule.updateWidgetVerdict(verdictJson);
    } catch {}
  }
}

export function closeWidget(): void {
  if (Platform.OS === 'android' && OverlayPermissionModule?.closeWidget) {
    try {
      OverlayPermissionModule.closeWidget();
    } catch {}
  }
}

export async function checkOverlayPermission(): Promise<boolean> {
  if (Platform.OS === 'android' && OverlayPermissionModule?.checkOverlayPermission) {
    try {
      return await OverlayPermissionModule.checkOverlayPermission();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Opens Settings.ACTION_MANAGE_OVERLAY_PERMISSION. Resolves true when the
 * permission is already granted; false when the settings screen was opened
 * (the AppState listener in App.tsx picks up the grant on return).
 */
export async function requestOverlayPermission(): Promise<boolean> {
  if (Platform.OS === 'android' && OverlayPermissionModule?.requestOverlayPermission) {
    try {
      return await OverlayPermissionModule.requestOverlayPermission();
    } catch {
      return false;
    }
  }
  return false;
}

/** Force the widget card open (called when a Listen session starts). */
export function expandWidget(): void {
  if (Platform.OS === 'android' && OverlayPermissionModule?.expandWidget) {
    try {
      OverlayPermissionModule.expandWidget();
    } catch {}
  }
}

/** Start the floating widget foreground service (idempotent). */
export function startFloatingWidget(): void {
  if (Platform.OS === 'android' && OverlayPermissionModule?.startFloatingWidget) {
    try {
      OverlayPermissionModule.startFloatingWidget();
    } catch {}
  }
}

/** Stop and remove the floating widget. */
export function stopFloatingWidget(): void {
  if (Platform.OS === 'android' && OverlayPermissionModule?.stopFloatingWidget) {
    try {
      OverlayPermissionModule.stopFloatingWidget();
    } catch {}
  }
}

export function openVendorAutoStartSettings(): void {
  if (Platform.OS === 'android' && OverlayPermissionModule?.openVendorAutoStartSettings) {
    try {
      OverlayPermissionModule.openVendorAutoStartSettings();
    } catch {}
  }
}

/**
 * Subscribe to bubble taps: each tap starts the existing Listen session.
 * Returns a subscription with .remove(), or null off-Android / on failure.
 */
export function subscribeFloatingWidgetTap(
  callback: () => void,
): {remove: () => void} | null {
  if (Platform.OS !== 'android' || !OverlayPermissionModule) return null;
  try {
    const emitter = new NativeEventEmitter(OverlayPermissionModule);
    return emitter.addListener('onFloatingWidgetTap', callback);
  } catch {
    return null;
  }
}
