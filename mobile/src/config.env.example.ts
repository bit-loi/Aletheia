/**
 * config.env.example.ts: Template for the local, untracked config.env.ts.
 *
 * Copy this file to src/config.env.ts and fill in the real values:
 *
 *   cp src/config.env.example.ts src/config.env.ts
 *
 * config.env.ts is gitignored. Nothing in this directory should ever hold a
 * real credential — the app is a package a user can unzip, so a token shipped
 * inside it is a published token. MOBILE_API_TOKEN is deliberately only a
 * shared client credential that gates the proxy; the Gemini and Tavily keys
 * stay on the Worker.
 */

export const ENV = {
  /**
   * Must match the Worker secret MOBILE_API_TOKEN character-for-character, or
   * the proxy rejects every request with 403. Set it on the Worker with:
   *
   *   cd ../proxy && npx wrangler secret put MOBILE_API_TOKEN
   */
  MOBILE_API_TOKEN: '',
};
