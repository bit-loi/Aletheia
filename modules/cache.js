/**
 * cache.js: Claim-level verdict caching via chrome.storage.local.
 *
 * Caches verdicts keyed by a SHA-256 hash of the normalized claim text.
 * This means identical/near-identical claims across different articles
 * get instant results without re-running the pipeline.
 *
 * TTL: 24 hours (configurable). Stale entries are treated as cache misses.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_PREFIX = 'vc_'; // "verdict cache", avoids key collisions

/**
 * Normalize claim text for consistent cache keys.
 * Lowercases, trims, collapses whitespace.
 */
function normalizeClaim(claim) {
  return claim.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * SHA-256 hash a string, return hex digest.
 * Uses the Web Crypto API (available in service workers).
 */
async function hashClaim(claim) {
  const normalized = normalizeClaim(claim);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return CACHE_PREFIX + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Look up a cached verdict for a claim.
 * @param {string} claim  The claim text.
 * @returns {Promise<object|null>}  Cached verdict data, or null if miss/stale.
 */
export async function getCachedVerdict(claim) {
  const key = await hashClaim(claim);

  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      const entry = result[key];
      if (!entry) return resolve(null);

      // TTL check
      if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        // Stale: remove and treat as miss
        chrome.storage.local.remove([key]);
        return resolve(null);
      }

      resolve(entry.data);
    });
  });
}

/**
 * Store a verdict in the cache.
 * @param {string} claim       The claim text.
 * @param {object} verdictData The verdict object to cache.
 */
export async function cacheVerdict(claim, verdictData) {
  const key = await hashClaim(claim);

  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [key]: {
          data: verdictData,
          timestamp: Date.now(),
        },
      },
      resolve
    );
  });
}

/**
 * Clear all cached verdicts (useful for debugging).
 */
export async function clearCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const cacheKeys = Object.keys(items).filter((k) => k.startsWith(CACHE_PREFIX));
      if (cacheKeys.length > 0) {
        chrome.storage.local.remove(cacheKeys, resolve);
      } else {
        resolve();
      }
    });
  });
}
