/**
 * pipeline.js: Shared fact-checking pipeline powered by NVIDIA NIM (MiniMax M3).
 *
 * Three stages:
 *   1. extractClaims(text)     → string[]          : pulls falsifiable claims from text
 *   2. retrieveEvidence(claim) → EvidenceItem[]     : web search for each claim via Tavily
 *   3. generateVerdict(claim, evidence) → Verdict   : grounded True/False/Misleading/Unverified
 *
 * All API calls happen in the service-worker context (no CORS issues).
 */

import { CONFIG } from '../config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads API keys from chrome.storage.sync.
 */
export async function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(
      ['llmKey', 'nvidiaKey', 'tavilyKey', 'deepgramKey'],
      (data) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve({
          // `nvidiaKey` is the legacy name, read so anyone who already saved a
          // key does not silently lose it after the switch to Gemini.
          llmKey: data.llmKey || data.nvidiaKey || CONFIG.LLM_API_KEY,
          tavilyKey: data.tavilyKey || CONFIG.TAVILY_API_KEY,
          deepgramKey: data.deepgramKey || CONFIG.DEEPGRAM_API_KEY,
        });
      }
    );
  });
}

/**
 * Safely parse a JSON string that the LLM might have wrapped in markdown fences or conversational text.
 */
function parseJSON(raw) {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try parsing directly first
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // Extract JSON array if present
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (_) {}
  }

  // Extract JSON object if present
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {}
  }

  throw new Error(`Invalid JSON format: ${raw.slice(0, 150)}`);
}

/**
 * Calls NVIDIA NIM API directly using minimaxai/minimax-m3 model.
 * Without a personal key this routes through the proxy, which owns provider
 * failover. With a personal key it calls the provider directly. Either way a
 * total failure throws: it never substitutes placeholder content.
 */
/**
 * Call the hosted proxy, which holds provider keys server-side and fails over
 * across a provider chain. This is the default path: it is what lets the
 * extension work on install with nothing configured.
 */
async function callProxy(path, body) {
  const base = (CONFIG.PROXY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('No API key configured and no proxy URL set.');

  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new Error('Aletheia is busy right now (shared quota). Try again shortly, or add your own API keys in the extension popup.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Proxy error (${res.status})`);
  }
  return res.json();
}

/** Evidence retrieval through the proxy, for users with no Tavily key. */
async function retrieveEvidenceViaProxy(claim) {
  try {
    const data = await callProxy('/v1/search', { query: claim, max_results: 3 });
    return (data.results || []).map((r) => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      snippet: r.snippet || '',
    }));
  } catch (err) {
    console.warn('[Aletheia] Proxy search failed:', err.message);
    return [];
  }
}

export async function callNVIDIA_NIM(promptText, temperature = 0.3, maxTokens = 2048) {
  const { llmKey } = await getSettings();
  const apiKey = llmKey && llmKey.trim() ? llmKey.trim() : CONFIG.LLM_API_KEY;

  // No personal key: the proxy answers, and handles provider failover itself.
  if (!apiKey) {
    const data = await callProxy('/v1/chat', {
      messages: [{ role: 'user', content: promptText }],
      temperature,
      max_tokens: maxTokens,
    });
    return data.content;
  }

  const url = CONFIG.LLM_DIRECT_URL;
  const modelsToTry = [CONFIG.LLM_DIRECT_MODEL];

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: promptText }],
          temperature: temperature,
          top_p: 0.95,
          max_tokens: maxTokens,
          stream: false,
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        console.warn(`[Aletheia] Model ${model} returned ${res.status}; no further direct fallback.`);
        lastError = new Error(`LLM API status ${res.status}`);
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.warn(`[Aletheia] NVIDIA API error (${res.status}): ${errBody.slice(0, 100)}`);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content && content.trim().length > 0) {
        return content;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Aletheia] Error with model ${model}, trying next model...`, err.message);
    }
  }

  // Fail loudly. This previously returned hardcoded "demo" claims here, and a
  // hardcoded {verdict: "True", confidence: "High"} with a fabricated source,
  // so an API outage produced confident fiction that was indistinguishable from
  // a real result. For a fact-checking tool that is the worst possible failure
  // mode: an error box is recoverable, an invented verdict is not.
  //
  // Provider failover now lives in the proxy (proxy/src/index.js), so a single
  // busy endpoint no longer takes the pipeline down.
  throw lastError || new Error('All model providers are unavailable. Try again shortly.');
}

// ─── Stage 1: Claim Extraction ────────────────────────────────────────────────

const CLAIM_EXTRACTION_PROMPT = `You are a fact-checking assistant. Your task is to extract specific, discrete, falsifiable factual claims from the following text.

Rules:
- Only include claims that can be verified against external sources (statistics, events, attributions, scientific statements).
- Each claim must be self-contained (understandable without the surrounding text).
- Do NOT include opinions, predictions, rhetorical questions, or vague statements.
- Do NOT include claims that are trivially obvious (e.g. "the sky is blue").
- Rewrite each claim as a clear, concise sentence. Do not just copy chunks of the source text.
- Limit to the 2–4 most significant, distinct, and verifiable claims.
- Return ONLY a valid JSON array of strings. No explanation, no markdown, no extra text.

Example output:
["Indonesia's GDP grew 5.1% in Q3 2025.", "The WHO declared mpox a global health emergency in August 2024."]`;

/**
 * Calls MiniMax M3 via NVIDIA NIM to extract checkable claims from text.
 * @param {string} text  The article body or transcript chunk.
 * @returns {Promise<string[]>}  Array of claim strings.
 */
export async function extractClaims(text) {
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;
  const prompt = CLAIM_EXTRACTION_PROMPT + `\n\nText to analyze:\n"""\n${truncated}\n"""`;

  const content = await callNVIDIA_NIM(prompt, 0.2, 2048);

  try {
    const claims = parseJSON(content);
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error('Parsed result is not a non-empty array.');
    }
    // Sanity filter: drop anything under 10 chars, limit to top 3 claims per chunk
    const filtered = claims.filter((c) => typeof c === 'string' && c.trim().length >= 10);
    return filtered.slice(0, 3);
  } catch (parseErr) {
    console.warn('[Aletheia] Failed to parse claims JSON, attempting line-split fallback:', parseErr);
    const lines = content
      .split('\n')
      .map((l) => l.replace(/^[\d\-\.\)\*]+\s*/, '').trim())
      .filter((l) => l.length >= 10);
    if (lines.length === 0) {
      throw new Error('Could not parse any claims from LLM response.');
    }
    return lines.slice(0, 3);
  }
}

// ─── Stage 2: Evidence Retrieval ──────────────────────────────────────────────

/**
 * Calls Tavily Search API to retrieve ground-truth snippets for a claim.
 * @param {string} claim
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function retrieveEvidence(claim) {
  const { tavilyKey } = await getSettings();

  // No personal key: go through the proxy, which holds one server-side.
  if (!tavilyKey) {
    return retrieveEvidenceViaProxy(claim);
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query: claim,
      search_depth: 'basic',
      max_results: 3,
      include_answer: false,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Tavily API error (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const results = data.results || [];

  return results.map((r) => ({
    title: r.title || 'Untitled',
    url: r.url || '',
    snippet: r.content || r.snippet || '',
  }));
}

// ─── Stage 3: Verdict Generation ─────────────────────────────────────────────

const VERDICT_PROMPT = `You are a rigorous fact-checker. Evaluate the following claim based ONLY on the evidence provided below. Do NOT use your own training knowledge. Ground your verdict strictly in the supplied sources.

Claim:
"{CLAIM}"

Evidence:
{EVIDENCE}

Respond with ONLY valid JSON (no markdown fences, no extra text):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "2–3 sentence explanation of your reasoning, referencing specific sources",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Verdict definitions:
- True: the claim is well-supported by the evidence.
- False: the evidence clearly contradicts the claim.
- Misleading: the claim contains a grain of truth but omits critical context, exaggerates, or distorts.
- Unverified: the evidence is insufficient to confirm or deny the claim.`;

/**
 * Generates a grounded verdict for a single claim using MiniMax M3.
 * @param {string} claim
 * @param {Array<{title: string, url: string, snippet: string}>} evidence
 * @returns {Promise<{verdict: string, explanation: string, confidence: string, key_sources: string[]}>}
 */
export async function generateVerdict(claim, evidence) {
  const evidenceText =
    evidence.length > 0
      ? evidence
          .map((e, i) => `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`)
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const prompt = VERDICT_PROMPT.replace('{CLAIM}', claim).replace('{EVIDENCE}', evidenceText);

  const content = await callNVIDIA_NIM(prompt, 0.1, 1024);

  try {
    const verdict = parseJSON(content);
    const validVerdicts = ['True', 'False', 'Misleading', 'Unverified'];
    if (!validVerdicts.includes(verdict.verdict)) {
      verdict.verdict = 'Unverified';
    }
    return {
      verdict: verdict.verdict,
      explanation: verdict.explanation || 'No explanation provided.',
      confidence: verdict.confidence || 'Low',
      key_sources: Array.isArray(verdict.key_sources) ? verdict.key_sources : [],
    };
  } catch (parseErr) {
    console.warn('[Aletheia] Failed to parse verdict JSON:', parseErr, content);
    return {
      verdict: 'Unverified',
      explanation: 'Could not parse the fact-check result. Raw response: ' + content.slice(0, 200),
      confidence: 'Low',
      key_sources: [],
    };
  }
}
