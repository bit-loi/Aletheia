/**
 * transcribe.ts: Batch audio transcription via the Gemini API (through the proxy).
 *
 * Instead of the streaming Gemini Live WebSocket used by the browser extension,
 * mobile uses batch transcription: record 15 seconds of audio, upload the full
 * buffer, get the complete transcript back. This is simpler, more accurate for
 * short clips, and avoids managing a WebSocket connection during app backgrounding.
 *
 * The audio is base64-encoded and posted to the proxy's /v1/transcribe
 * endpoint, which forwards it to Gemini's native generateContent as
 * inline_data. It does not go through /v1/chat: that route speaks the
 * OpenAI-compatible chat shape, which has no audio surface on Gemini, and its
 * 128 KB body cap is far below the ~640 KB a 15 s clip base64s to.
 */

import { CONFIG } from './config';

/**
 * Transcribe a recorded clip through the proxy.
 *
 * @param audioBase64 - Base64-encoded audio data (WAV or MP3)
 * @param mimeType - MIME type of the audio (e.g., 'audio/wav', 'audio/mp3')
 * @returns The transcript text
 */
export async function transcribeAudio(
  audioBase64: string,
  mimeType: string = 'audio/wav',
): Promise<string> {
  const base = (CONFIG.PROXY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('The Aletheia proxy is not configured.');

  const res = await fetch(`${base}/v1/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(CONFIG.MOBILE_API_TOKEN
        ? { Authorization: `Bearer ${CONFIG.MOBILE_API_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({ audio: audioBase64, mimeType }),
  });

  if (res.status === 429) {
    throw new Error('Aletheia is busy right now. Try again shortly.');
  }
  if (res.status === 413) {
    throw new Error('The recording is too long to send. Try a shorter clip.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as any).error || `Transcription failed (${res.status})`);
  }

  const data = await res.json();
  const transcript = ((data as any).transcript || '').trim();

  // Silence is a real outcome, not a failure to hide. Say what to change.
  if (!transcript || (data as any).inaudible) {
    throw new Error(
      'Could not transcribe the audio. Make sure the phone speaker is not muted ' +
        'and headphones are disconnected.',
    );
  }

  return transcript;
}

/**
 * Convert a file URI or asset path to base64.
 * This is a React Native utility that reads a local file and returns its
 * base64 content.
 */
export async function fileToBase64(filePath: string): Promise<string> {
  // This will be implemented using react-native-fs or expo-file-system
  // For now, we import RNFS dynamically
  try {
    const RNFS = require('react-native-fs');
    return await RNFS.readFile(filePath, 'base64');
  } catch (err) {
    throw new Error(
      `Cannot read audio file: ${(err as Error).message}. ` +
        'Make sure react-native-fs is installed.',
    );
  }
}
