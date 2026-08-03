/**
 * useListenSession.ts: Custom hook that orchestrates the Listen flows.
 *
 * One-shot session (startSession):
 *   1. Check headphones → warn if connected
 *   2. Request mic permission
 *   3. Start recording (15s auto-stop)
 *   4. Transcribe the recorded audio (batch)
 *   5. Merge context (audio + OCR in Phase 2)
 *   6. Run verification pipeline
 *   7. Return results to UI
 *
 * Auto-listen (startAutoSession) is what the extension does on desktop: start
 * once, then verdicts keep arriving with no further taps. The microphone stays
 * open natively and each finished 15 s window is transcribed and verified
 * while the next one is already being recorded.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  expandWidget,
  startRecording,
  stopRecording,
  startContinuousRecording,
  stopContinuousRecording,
  deleteRecording,
  isHeadphonesConnected,
  requestMicrophonePermission,
  updateWidgetStatus,
  updateWidgetVerdict,
  type RecordingState,
} from './audioCapture';
import { transcribeAudio, transcribeAudioDetailed, fileToBase64 } from './transcribe';
import { mergeContext, type MergedContext } from './mergeContext';
import {
  verifyTranscript,
  extractClaims,
  retrieveEvidence,
  generateVerdict,
  type ClaimResult,
  type VerificationResult,
} from './verifyContent';

export type SessionPhase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'verifying'
  | 'done'
  | 'error';

/** Consecutive failed windows before auto-listen gives up rather than looping on a broken proxy. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Claim text → cache key, mirroring the extension's normalizeClaim. */
function normalizeClaim(claim: string): string {
  return claim.toLowerCase().trim().replace(/\s+/g, ' ');
}

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
  /** True while auto-listen is running (mic open, verdicts arriving on their own). */
  auto: boolean;
  /** Number of audio windows processed in the current auto-listen run. */
  windowsProcessed: number;
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
    auto: false,
    windowsProcessed: 0,
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

  // ─── Auto-listen ───────────────────────────────────────────────────────────

  const autoRef = useRef(false);
  const langRef = useRef<'id' | 'en'>('id');
  /** A window is being transcribed/verified right now. */
  const busyRef = useRef(false);
  /** Newest window that arrived while busy. Older backlog is dropped. */
  const pendingChunkRef = useRef<string | null>(null);
  /** Claims already verified in this run, so a repeated claim costs nothing. */
  const seenClaimsRef = useRef<Set<string>>(new Set());
  const lastTranscriptRef = useRef('');
  const failuresRef = useRef(0);

  const stopAutoSession = useCallback(async () => {
    autoRef.current = false;
    busyRef.current = false;
    if (pendingChunkRef.current) {
      deleteRecording(pendingChunkRef.current);
      pendingChunkRef.current = null;
    }
    await stopContinuousRecording();
    updateWidgetStatus(langRef.current === 'en' ? 'Aletheia • Stopped' : 'Aletheia • Berhenti');
    setState((prev) => ({
      ...prev,
      auto: false,
      amplitude: 0,
      statusText: '',
      phase: prev.result && prev.result.claims.length > 0 ? 'done' : 'idle',
    }));
  }, []);

  /**
   * Transcribe and verify one recorded window.
   *
   * Everything here is best-effort: silence, a window with no factual claims,
   * and a claim already checked earlier in the run are all normal outcomes
   * that must leave the loop running.
   */
  const processChunk = useCallback(async (filePath: string) => {
    const lang = langRef.current;
    const say = (en: string, id: string) => (lang === 'en' ? en : id);

    if (busyRef.current) {
      // Verification is slower than recording, so windows queue up. Keep only
      // the newest — falling further behind live audio helps nobody.
      const dropped = pendingChunkRef.current;
      if (dropped) deleteRecording(dropped);
      pendingChunkRef.current = filePath;
      return;
    }

    busyRef.current = true;

    try {
      updateState({ phase: 'transcribing', statusText: say('Transcribing audio…', 'Transkripsi audio…') });
      updateWidgetStatus(say('Transcribing audio…', 'Transkripsi audio…'));

      const audioBase64 = await fileToBase64(filePath);
      await deleteRecording(filePath);

      const { transcript, inaudible } = await transcribeAudioDetailed(audioBase64, 'audio/wav');
      failuresRef.current = 0;
      if (!autoRef.current) return;

      setState((prev) => ({ ...prev, windowsProcessed: prev.windowsProcessed + 1 }));

      if (!transcript || inaudible) {
        updateState({ phase: 'recording', statusText: say('Listening…', 'Mendengarkan…') });
        updateWidgetStatus(say('Listening…', 'Mendengarkan…'));
        return;
      }

      // Repeating the same window (a paused video, a looping clip) would burn
      // quota for a result already on screen.
      if (normalizeClaim(transcript) === lastTranscriptRef.current) {
        updateState({ phase: 'recording', statusText: say('Listening…', 'Mendengarkan…') });
        updateWidgetStatus(say('Listening…', 'Mendengarkan…'));
        return;
      }
      lastTranscriptRef.current = normalizeClaim(transcript);

      updateState({ phase: 'verifying', statusText: say('Extracting claims…', 'Mengekstrak klaim…') });
      updateWidgetStatus(say('Extracting claims…', 'Mengekstrak klaim…'));

      // The per-claim path is used rather than /v1/verify-mobile so already
      // seen claims can be skipped before any search or verdict call is made.
      const claims = await extractClaims(transcript, lang);
      if (!autoRef.current) return;

      const fresh = claims.filter((c) => !seenClaimsRef.current.has(normalizeClaim(c)));
      if (fresh.length === 0) {
        updateState({ phase: 'recording', statusText: say('Listening…', 'Mendengarkan…') });
        updateWidgetStatus(say('Listening…', 'Mendengarkan…'));
        return;
      }

      for (let i = 0; i < fresh.length; i++) {
        if (!autoRef.current) return;
        const claim = fresh[i];
        seenClaimsRef.current.add(normalizeClaim(claim));

        updateState({
          statusText: say(`Checking claim ${i + 1} of ${fresh.length}…`, `Memeriksa klaim ${i + 1} dari ${fresh.length}…`),
        });
        updateWidgetStatus(
          say(`Checking claim ${i + 1} of ${fresh.length}…`, `Memeriksa klaim ${i + 1} dari ${fresh.length}…`),
        );

        const evidence = await retrieveEvidence(claim);
        const verdict = await generateVerdict(claim, evidence, lang);
        if (!autoRef.current) return;

        const claimResult: ClaimResult = { claim, verdict };

        // Each verdict is pushed as it lands, so the card feed fills up while
        // the next window is still recording.
        updateWidgetVerdict(
          JSON.stringify({
            claim: claimResult.claim,
            verdict: verdict.verdict,
            explanation: verdict.explanation,
            confidence: verdict.confidence,
            key_sources: verdict.key_sources,
          }),
        );

        setState((prev) => ({
          ...prev,
          result: {
            claims: [...(prev.result?.claims ?? []), claimResult],
            rawTranscript: prev.result
              ? `${prev.result.rawTranscript}\n${transcript}`.trim()
              : transcript,
          },
        }));
      }

      if (autoRef.current) {
        updateState({ phase: 'recording', statusText: say('Listening…', 'Mendengarkan…') });
        updateWidgetStatus(say('Listening…', 'Mendengarkan…'));
      }
    } catch (err: any) {
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        // Looping against a proxy that keeps failing just burns battery and
        // hides the reason, so surface it and stop.
        await stopAutoSession();
        updateState({
          phase: 'error',
          error: err.message || say('Auto-listen stopped after repeated failures.', 'Mode otomatis berhenti setelah beberapa kegagalan.'),
        });
        return;
      }
      updateState({ phase: 'recording', statusText: say('Retrying…', 'Mencoba lagi…') });
      updateWidgetStatus(say('Retrying…', 'Mencoba lagi…'));
    } finally {
      busyRef.current = false;
      const queued = pendingChunkRef.current;
      pendingChunkRef.current = null;
      if (queued) {
        if (autoRef.current) processChunk(queued);
        else deleteRecording(queued);
      }
    }
  }, [updateState, stopAutoSession]);

  /**
   * Start auto-listen: one call, then verdicts keep arriving until stopped.
   */
  const startAutoSession = useCallback(async (lang: 'id' | 'en' = 'id') => {
    if (autoRef.current) return;
    langRef.current = lang;
    const say = (en: string, id: string) => (lang === 'en' ? en : id);

    seenClaimsRef.current = new Set();
    lastTranscriptRef.current = '';
    failuresRef.current = 0;

    updateState({
      phase: 'idle',
      statusText: '',
      amplitude: 0,
      context: null,
      result: null,
      error: null,
      auto: false,
      windowsProcessed: 0,
    });

    const headphones = await checkHeadphones();
    if (headphones) {
      updateWidgetStatus(say('Aletheia • Headphones detected', 'Aletheia • Headphone terdeteksi'));
      updateState({
        phase: 'error',
        error: say(
          'Headphones detected! Unplug headphones or disconnect Bluetooth audio so TikTok/YouTube audio plays through the phone speaker.',
          'Headphone terdeteksi! Harap lepaskan headphone agar audio TikTok/YouTube keluar dari speaker HP.',
        ),
      });
      return;
    }

    const granted = await requestMicrophonePermission();
    if (!granted) {
      updateWidgetStatus(say('Aletheia • Mic permission required', 'Aletheia • Izin mikrofon diperlukan'));
      updateState({
        phase: 'error',
        error: say(
          'Microphone permission is required to listen and verify audio.',
          'Izin mikrofon diperlukan untuk mendengarkan dan memverifikasi audio.',
        ),
      });
      return;
    }

    autoRef.current = true;
    updateState({ phase: 'recording', auto: true, statusText: say('Listening…', 'Mendengarkan…') });
    updateWidgetStatus(say('Listening…', 'Mendengarkan…'));
    expandWidget();

    try {
      await startContinuousRecording({
        onChunk: (path) => {
          if (!autoRef.current) {
            deleteRecording(path);
            return;
          }
          processChunk(path);
        },
        onError: (message) => {
          updateState({ phase: 'error', auto: false, error: message });
        },
        onAmplitude: (amp) => {
          updateState({ amplitude: amp });
        },
      });
    } catch (err: any) {
      autoRef.current = false;
      updateWidgetStatus(say('Aletheia • Check failed', 'Aletheia • Gagal memeriksa'));
      updateState({
        phase: 'error',
        auto: false,
        error: err.message || say('Could not start auto-listen.', 'Tidak dapat memulai mode otomatis.'),
      });
    }
  }, [checkHeadphones, processChunk, updateState]);

  // Leaving the screen must not leave the microphone open.
  useEffect(() => {
    return () => {
      if (autoRef.current) {
        autoRef.current = false;
        stopContinuousRecording();
      }
    };
  }, []);

  /**
   * Cancel the current session (stop recording if active).
   */
  const cancelSession = useCallback(async () => {
    if (autoRef.current) {
      await stopAutoSession();
      return;
    }
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
  }, [updateState, stopAutoSession]);

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
      windowsProcessed: 0,
    });
    seenClaimsRef.current = new Set();
    lastTranscriptRef.current = '';
  }, [updateState]);

  return {
    state,
    startSession,
    startAutoSession,
    stopAutoSession,
    cancelSession,
    resetSession,
    checkHeadphones,
  };
}
