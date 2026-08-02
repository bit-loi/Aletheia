/**
 * useListenSession.ts: Custom hook that orchestrates the full Listen flow.
 *
 * This is the glue between the UI and the pipeline modules:
 *   1. Check headphones → warn if connected
 *   2. Request mic permission
 *   3. Start recording (15s auto-stop)
 *   4. Transcribe the recorded audio (batch)
 *   5. Merge context (audio + OCR in Phase 2)
 *   6. Run verification pipeline
 *   7. Return results to UI
 */

import { useState, useCallback, useRef } from 'react';
import {
  expandWidget,
  startRecording,
  stopRecording,
  isHeadphonesConnected,
  requestMicrophonePermission,
  updateWidgetStatus,
  updateWidgetVerdict,
  type RecordingState,
} from './audioCapture';
import { transcribeAudio, fileToBase64 } from './transcribe';
import { mergeContext, type MergedContext } from './mergeContext';
import {
  verifyTranscript,
  type VerificationResult,
} from './verifyContent';

export type SessionPhase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'verifying'
  | 'done'
  | 'error';

export interface ListenSessionState {
  phase: SessionPhase;
  /** Progress text shown during processing. */
  statusText: string;
  /** Current microphone amplitude (0-1) for the pulsing animation. */
  amplitude: number;
  /** Whether headphones are detected. */
  headphonesConnected: boolean;
  /** The merged context (after transcription). */
  context: MergedContext | null;
  /** Verification results (after pipeline completes). */
  result: VerificationResult | null;
  /** Error message if something went wrong. */
  error: string | null;
}

export function useListenSession() {
  const [state, setState] = useState<ListenSessionState>({
    phase: 'idle',
    statusText: '',
    amplitude: 0,
    headphonesConnected: false,
    context: null,
    result: null,
    error: null,
  });

  const recordingRef = useRef(false);

  const updateState = useCallback(
    (partial: Partial<ListenSessionState>) => {
      setState((prev) => ({ ...prev, ...partial }));
    },
    [],
  );

  /**
   * Check headphone status. Call this on mount and periodically.
   */
  const checkHeadphones = useCallback(async () => {
    const connected = await isHeadphonesConnected();
    updateState({ headphonesConnected: connected });
    return connected;
  }, [updateState]);

  /**
   * Start the full Listen session.
   */
  const startSession = useCallback(async (lang: 'id' | 'en' = 'id') => {
    // Reset state
    updateState({
      phase: 'idle',
      statusText: '',
      amplitude: 0,
      context: null,
      result: null,
      error: null,
    });

    try {
      // 1. Check headphones
      const headphones = await checkHeadphones();
      if (headphones) {
        updateWidgetStatus(lang === 'en' ? 'Aletheia • Headphones detected' : 'Aletheia • Headphone terdeteksi');
        updateState({
          phase: 'error',
          error:
            lang === 'en'
              ? 'Headphones detected! Unplug headphones or disconnect Bluetooth audio so TikTok/YouTube audio plays through the phone speaker.'
              : 'Headphone terdeteksi! Harap lepaskan headphone agar audio TikTok/YouTube keluar dari speaker HP.',
        });
        return;
      }

      // 2. Request microphone permission
      const granted = await requestMicrophonePermission();
      if (!granted) {
        updateWidgetStatus(lang === 'en' ? 'Aletheia • Mic permission required' : 'Aletheia • Izin mikrofon diperlukan');
        updateState({
          phase: 'error',
          error: lang === 'en' ? 'Microphone permission is required to listen and verify audio.' : 'Izin mikrofon diperlukan untuk mendengarkan dan memverifikasi audio.',
        });
        return;
      }

      // 3. Start recording
      recordingRef.current = true;
      updateState({ phase: 'recording', statusText: lang === 'en' ? 'Listening…' : 'Mendengarkan…' });
      updateWidgetStatus(lang === 'en' ? 'Listening…' : 'Mendengarkan…');
      // Any session start also expands the floating widget card so the live
      // status text is visible even if the session was started from the app
      // button rather than the bubble.
      expandWidget();

      const filePath = await new Promise<string>((resolve, reject) => {
        startRecording({
          onStateChange: (recordState: RecordingState) => {
            if (recordState === 'processing') {
              updateState({ statusText: lang === 'en' ? 'Processing audio…' : 'Memproses audio…' });
              updateWidgetStatus(lang === 'en' ? 'Processing audio…' : 'Memproses audio…');
            }
          },
          onError: (err: string) => {
            recordingRef.current = false;
            reject(new Error(err));
          },
          onComplete: (path: string) => {
            recordingRef.current = false;
            resolve(path);
          },
          onAmplitude: (amp: number) => {
            updateState({ amplitude: amp });
          },
        });
      });

      // 4. Transcribe
      updateState({ phase: 'transcribing', statusText: lang === 'en' ? 'Transcribing audio…' : 'Transkripsi audio…' });
      updateWidgetStatus(lang === 'en' ? 'Transcribing audio…' : 'Transkripsi audio…');
      const audioBase64 = await fileToBase64(filePath);
      const transcript = await transcribeAudio(audioBase64, 'audio/wav');

      // 5. Merge context (audio-only in Phase 1)
      const merged = mergeContext(transcript, []);
      updateState({ context: merged });

      // 6. Verify
      updateState({ phase: 'verifying', statusText: lang === 'en' ? 'Verifying claims…' : 'Memeriksa klaim…' });
      updateWidgetStatus(lang === 'en' ? 'Verifying claims…' : 'Memeriksa klaim…');
      const result = await verifyTranscript(merged.combinedText, lang, (status) => {
        updateState({ statusText: status });
        updateWidgetStatus(status);
      });

      // 7. Done! The verdict is pushed to the floating widget WebView as the
      // same JSON shape the extension's card renderer consumes.
      if (result.claims.length > 0) {
        const top = result.claims[0];
        const vText = top.verdict.verdict === 'True' ? (lang === 'en' ? 'TRUE' : 'BENAR') : top.verdict.verdict === 'False' ? (lang === 'en' ? 'FALSE' : 'SALAH') : top.verdict.verdict === 'Misleading' ? (lang === 'en' ? 'MISLEADING' : 'MENYESATKAN') : (lang === 'en' ? 'UNVERIFIED' : 'BELUM DIVERIFIKASI');
        updateWidgetStatus(`${lang === 'en' ? 'Claim' : 'Klaim'}: ${vText}`);
        updateWidgetVerdict(
          JSON.stringify({
            claim: top.claim,
            verdict: top.verdict.verdict,
            explanation: top.verdict.explanation,
            confidence: top.verdict.confidence,
            key_sources: top.verdict.key_sources,
          }),
        );
      } else {
        updateWidgetStatus(lang === 'en' ? 'Aletheia • Done' : 'Aletheia • Selesai');
      }
      updateState({ phase: 'done', result, statusText: '' });
    } catch (err: any) {
      updateWidgetStatus(lang === 'en' ? 'Aletheia • Check failed' : 'Aletheia • Gagal memeriksa');
      updateState({
        phase: 'error',
        error: err.message || 'An unexpected error occurred.',
        statusText: '',
      });
    }
  }, [checkHeadphones, updateState]);

  /**
   * Cancel the current session (stop recording if active).
   */
  const cancelSession = useCallback(async () => {
    if (recordingRef.current) {
      await stopRecording();
      recordingRef.current = false;
    }
    updateState({
      phase: 'idle',
      statusText: '',
      amplitude: 0,
      error: null,
    });
  }, [updateState]);

  /**
   * Reset to idle state after viewing results.
   */
  const resetSession = useCallback(() => {
    updateState({
      phase: 'idle',
      statusText: '',
      amplitude: 0,
      context: null,
      result: null,
      error: null,
    });
  }, [updateState]);

  return {
    state,
    startSession,
    cancelSession,
    resetSession,
    checkHeadphones,
  };
}
