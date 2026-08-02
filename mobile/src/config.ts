/**
 * config.ts: Centralized configuration for Aletheia Mobile.
 *
 * Secrets live in config.env.ts (gitignored). Copy config.env.example.ts
 * to config.env.ts and fill in real values before running the app.
 */

import { ENV } from './config.env';

export const CONFIG = {
  /** Aletheia proxy (Cloudflare Worker) base URL. */
  PROXY_URL: 'https://aletheia-proxy.rizkymirza18.workers.dev',

  /**
   * Shared token for mobile auth against the Worker. Sent as
   * `Authorization: Bearer <token>` (and accepted via X-Aletheia-Client).
   * Must match the Worker secret MOBILE_API_TOKEN character-for-character
   * or the proxy rejects every request with 401.
   */
  MOBILE_API_TOKEN: ENV.MOBILE_API_TOKEN || '',

  /** Maximum recording duration in milliseconds. */
  MAX_RECORD_DURATION_MS: 15_000,

  /** Gemini model used for batch transcription via the proxy. */
  TRANSCRIPTION_MODEL: 'gemini-2.5-flash',

  /** PaddleOCR microservice URL (set to ngrok URL for demo). */
  OCR_SERVICE_URL: ENV.OCR_SERVICE_URL || '',
};
