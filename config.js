/**
 * config.js: Centralized configuration for Aletheia.
 * Note: Keep API keys empty by default to prevent exposing secrets in source code or repositories.
 */
export const CONFIG = {
  /**
   * Hosted proxy that holds the API keys server-side, so the extension works
   * on install with nothing to configure.
   *
   * Deliberately NOT an API key: a key shipped inside an extension is a
   * published key. The package is a zip that any user can read out of their own
   * profile directory, so the quota would immediately be everyone's.
   *
   * Legacy locally saved keys are still honored by the pipeline, but new
   * installs need no credential setup.
   */
  PROXY_URL: 'https://aletheia-proxy.rizkymirza18.workers.dev',

  /** Legacy direct-key fallback. Keep empty in source. */
  LLM_API_KEY: '',
  TAVILY_API_KEY: '',
  DEEPGRAM_API_KEY: '',

  /** Direct (bring-your-own-key) endpoint. Google's OpenAI-compatibility layer,
   *  so it shares the request shape used by the proxy's provider chain. */
  LLM_DIRECT_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  LLM_DIRECT_MODEL: 'gemini-2.5-flash',

  BUFFER_INTERVAL_MS: 15000,
};
