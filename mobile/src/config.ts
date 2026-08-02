/**
 * config.ts: Centralized configuration for Aletheia Mobile.
 *
 * All backend URLs and auth tokens are read from environment config,
 * never hardcoded. React Native does not have process.env in the
 * traditional Node sense, so we use react-native-config or inline
 * defaults that are overridden at build time.
 */

// In production, these come from .env via react-native-config.
// For the demo, they can be set directly here.
export const CONFIG = {
  /** Aletheia proxy (Cloudflare Worker) base URL. */
  PROXY_URL: 'https://aletheia-proxy.rizkymirza18.workers.dev',

  /** Bearer token for mobile auth against the Worker. */
  MOBILE_API_TOKEN: '',

  /** Maximum recording duration in milliseconds. */
  MAX_RECORD_DURATION_MS: 15_000,

  /** Gemini model used for batch transcription via the proxy. */
  TRANSCRIPTION_MODEL: 'gemini-2.5-flash',

  /** PaddleOCR microservice URL (Phase 2, not used in Phase 1). */
  OCR_SERVICE_URL: '',
};
