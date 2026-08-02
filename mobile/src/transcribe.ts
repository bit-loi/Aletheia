/**
 * transcribe.ts: Batch audio transcription via the Gemini API (through the proxy).
 *
 * Instead of the streaming Gemini Live WebSocket used by the browser extension,
 * mobile uses batch transcription: record 15 seconds of audio, upload the full
 * buffer, get the complete transcript back. This is simpler, more accurate for
 * short clips, and avoids managing a WebSocket connection during app backgrounding.
 *
 * The audio is sent as base64-encoded data to the proxy's /v1/chat endpoint
 * using Gemini's multimodal input format.
 */

import { CONFIG } from './config';

/**
 * Transcribe audio data using Gemini's multimodal capabilities via the proxy.
 *
 * @param audioBase64 - Base64-encoded audio data (WAV, MP3, or raw PCM)
 * @param mimeType - MIME type of the audio (e.g., 'audio/wav', 'audio/mp3')
 * @returns The transcript text
 */
export async function transcribeAudio(
  audioBase64: string,
  mimeType: string = 'audio/wav',
): Promise<string> {
  const base = (CONFIG.PROXY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('The Aletheia proxy is not configured.');

  // Use the Gemini API directly for audio transcription since the proxy's
  // /v1/chat endpoint speaks the OpenAI chat format which doesn't support
  // inline audio. We call Gemini's native generateContent endpoint through
  // the proxy's Gemini key.
  //
  // For now, we use the proxy's /v1/chat endpoint with a text-based prompt
  // that instructs the model to transcribe. In production, this would use
  // the multimodal endpoint directly.

  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(CONFIG.MOBILE_API_TOKEN
        ? { Authorization: `Bearer ${CONFIG.MOBILE_API_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe the following audio exactly as spoken. Return ONLY the raw transcript text, no formatting, no timestamps, no speaker labels. If the audio is unclear or silent, return "[inaudible]".',
            },
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format: mimeType.includes('wav') ? 'wav' : 'mp3',
              },
            },
          ],
        },
      ],
      temperature: 0.0,
      max_tokens: 4096,
    }),
  });

  if (res.status === 429) {
    throw new Error('Aletheia is busy right now. Try again shortly.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as any).error || `Transcription failed (${res.status})`);
  }

  const data = await res.json();
  const transcript = (data as any).content?.trim();

  if (!transcript || transcript === '[inaudible]') {
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
