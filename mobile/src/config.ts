/**
 * config.ts: Centralized configuration for Aletheia Mobile.
 *
 * Secrets live in config.env.ts (gitignored). Copy config.env.example.ts
 * to config.env.ts and fill in real values before running the app.
 */

import { ENV } from './config.env';

const env = ENV as { MOBILE_API_TOKEN?: string; PROXY_URL?: string };

export const CONFIG = {
  /** Aletheia proxy base URL. Override it for staging/self-hosted builds. */
  PROXY_URL: env.PROXY_URL || 'https://aletheia-proxy.rizkymirza18.workers.dev',

  /**
   * Shared token for mobile auth against the Worker. Sent as
   * `Authorization: Bearer <token>` (and accepted via X-Aletheia-Client).
   * Must match the Worker secret MOBILE_API_TOKEN character-for-character
   * or the proxy rejects every request with 401.
   */
  MOBILE_API_TOKEN: env.MOBILE_API_TOKEN || '',

  /** Maximum recording duration in milliseconds. */
  MAX_RECORD_DURATION_MS: 15_000,
};
