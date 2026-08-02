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

const { AudioRecorderModule } = NativeModules;

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

  try {
    // The native module handles:
    //   - Android: starting the foreground service, showing persistent notification,
    //     configuring MediaRecorder with mic source
    //   - iOS: configuring AVAudioSession, starting AVAudioRecorder
    const outputPath = await AudioRecorderModule.startRecording({
      maxDurationMs: CONFIG.MAX_RECORD_DURATION_MS,
      sampleRate: 16000,
      channels: 1,
      encoding: 'pcm_16bit',
      outputFormat: 'wav',
    });

    // Listen for amplitude updates (for the pulsing animation)
    if (AudioRecorderModule.addListener) {
      const emitter = new NativeEventEmitter(AudioRecorderModule);
      emitterSubscription = emitter.addListener('onAmplitude', (event) => {
        currentCallbacks?.onAmplitude?.(event.amplitude);
      });
    }

    // Auto-stop timer as a safety net (the native module also auto-stops)
    autoStopTimer = setTimeout(() => {
      stopRecording();
    }, CONFIG.MAX_RECORD_DURATION_MS + 1000);

    console.log('[Aletheia] Recording started, output:', outputPath);
  } catch (err: any) {
    currentCallbacks = null;
    callbacks.onStateChange('error');
    callbacks.onError(`Failed to start recording: ${err.message}`);
    throw err;
  }
}

/**
 * Stop the current recording and return the file path.
 */
export async function stopRecording(): Promise<string | null> {
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }

  if (emitterSubscription) {
    emitterSubscription.remove();
    emitterSubscription = null;
  }

  if (!currentCallbacks) {
    return null;
  }

  const callbacks = currentCallbacks;

  try {
    callbacks.onStateChange('processing');
    const filePath: string = await AudioRecorderModule.stopRecording();
    callbacks.onComplete(filePath);
    currentCallbacks = null;
    return filePath;
  } catch (err: any) {
    callbacks.onStateChange('error');
    callbacks.onError(`Failed to stop recording: ${err.message}`);
    currentCallbacks = null;
    return null;
  }
}

/**
 * Check if a recording is currently in progress.
 */
export function isRecording(): boolean {
  return currentCallbacks !== null;
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
  } catch (_) {
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

      if (AudioRecorderModule?.requestOverlayPermission) {
        await AudioRecorderModule.requestOverlayPermission().catch(() => {});
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

export function updateWidgetText(text: string): void {
  if (Platform.OS === 'android' && AudioRecorderModule?.updateWidgetText) {
    try {
      AudioRecorderModule.updateWidgetText(text);
    } catch (_) {}
  }
}

export function updateWidgetVerdict(verdict: string, claim: string, explanation: string): void {
  if (Platform.OS === 'android' && AudioRecorderModule?.updateWidgetVerdict) {
    try {
      AudioRecorderModule.updateWidgetVerdict(verdict, claim, explanation);
    } catch (_) {}
  }
}

export function closeWidget(): void {
  if (Platform.OS === 'android' && AudioRecorderModule?.closeWidget) {
    try {
      AudioRecorderModule.closeWidget();
    } catch (_) {}
  }
}

export async function checkOverlayPermission(): Promise<boolean> {
  if (Platform.OS === 'android' && AudioRecorderModule?.checkOverlayPermission) {
    try {
      return await AudioRecorderModule.checkOverlayPermission();
    } catch (_) {
      return true;
    }
  }
  return true;
}

export function openVendorAutoStartSettings(): void {
  if (Platform.OS === 'android' && AudioRecorderModule?.openVendorAutoStartSettings) {
    try {
      AudioRecorderModule.openVendorAutoStartSettings();
    } catch (_) {}
  }
}
