/**
 * pipeline.js: Shared fact-checking pipeline.
 *
 * Three stages:
 *   1. extractClaims(text)     → string[]          : pulls falsifiable claims from text
 *   2. retrieveEvidence(claim) → EvidenceItem[]     : web search for each claim
 *   3. generateVerdict(claim, evidence) → Verdict   : grounded True/False/Misleading/Unverified
 *
 * All API calls happen in the service-worker context (no CORS issues).
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads API keys + model selection from chrome.storage.sync.
 * Throws a clear error if required keys are missing.
 */
export async function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(
      ['openrouterKey', 'tavilyKey', 'deepgramKey', 'model'],
      (data) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve({
          openrouterKey: data.openrouterKey || '',
          tavilyKey: data.tavilyKey || '',
          deepgramKey: data.deepgramKey || '',
          model: data.model || 'anthropic/claude-sonnet-4',
        });
      }
    );
  });
}

function requireKey(key, name) {
  if (!key) {
    throw new Error(
      `${name} API key is not set. Open the Aletheia extension popup and add it.`
    );
  }
}

/**
 * Safely parse a JSON string that the LLM might have wrapped in markdown fences.
 */
function parseJSON(raw) {
  // Strip ```json ... ``` wrappers if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(cleaned);
}

// ─── Stage 1: Claim Extraction ────────────────────────────────────────────────

const CLAIM_EXTRACTION_PROMPT = `You are a fact-checking assistant. Your task is to extract specific, discrete, falsifiable factual claims from the following text.

Rules:
- Only include claims that can be verified against external sources (statistics, events, attributions, scientific statements).
- Each claim must be self-contained (understandable without the surrounding text).
- Do NOT include opinions, predictions, rhetorical questions, or vague statements.
- Do NOT include claims that are trivially obvious (e.g. "the sky is blue").
- Rewrite each claim as a clear, concise sentence. Do not just copy chunks of the source text.
- Limit to the 5–8 most significant and verifiable claims. Prioritize claims that are important, potentially controversial, or consequential.
- Return ONLY a valid JSON array of strings. No explanation, no markdown, no extra text.

Example output:
["Indonesia's GDP grew 5.1% in Q3 2025.", "The WHO declared mpox a global health emergency in August 2024."]

Text to analyze:
"""
{TEXT}
"""`;

/**
 * Calls the LLM to extract checkable claims from the given text.
 * @param {string} text  The article body or transcript chunk.
 * @returns {Promise<string[]>}  Array of claim strings.
 */
export async function extractClaims(text) {
  const { openrouterKey, model } = await getSettings();
  requireKey(openrouterKey, 'OpenRouter');

  // Truncate extremely long texts to avoid blowing context window / cost.
  // ~12 000 chars ≈ 3 000 tokens, which is plenty for claim extraction.
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;

  const prompt = CLAIM_EXTRACTION_PROMPT.replace('{TEXT}', truncated);

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openrouterKey}`,
      'HTTP-Referer': 'chrome-extension://aletheia',
      'X-Title': 'Aletheia Fact-Checker',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1, // Low temperature for factual extraction
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned empty response for claim extraction.');
  }

  try {
    const claims = parseJSON(content);
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error('Parsed result is not a non-empty array.');
    }
    // Sanity filter: drop anything under 10 chars (not a real claim)
    return claims.filter((c) => typeof c === 'string' && c.trim().length >= 10);
  } catch (parseErr) {
    console.warn('[Aletheia] Failed to parse claims JSON, attempting line-split fallback:', parseErr);
    // Fallback: split on newlines and treat each non-empty line as a claim
    const lines = content
      .split('\n')
      .map((l) => l.replace(/^[\d\-\.\)\*]+\s*/, '').trim())
      .filter((l) => l.length >= 10);
    if (lines.length === 0) {
      throw new Error('Could not parse any claims from LLM response.');
    }
    return lines.slice(0, 8);
  }
}

// ─── Stage 2: Evidence Retrieval ──────────────────────────────────────────────

/**
 * Searches for evidence related to a single claim using the Tavily API.
 * @param {string} claim  A single claim string.
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function retrieveEvidence(claim) {
  const { tavilyKey } = await getSettings();
  requireKey(tavilyKey, 'Tavily');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query: claim,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
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
 * Generates a grounded verdict for a single claim.
 * @param {string} claim
 * @param {Array<{title: string, url: string, snippet: string}>} evidence
 * @returns {Promise<{verdict: string, explanation: string, confidence: string, key_sources: string[]}>}
 */
export async function generateVerdict(claim, evidence) {
  const { openrouterKey, model } = await getSettings();
  requireKey(openrouterKey, 'OpenRouter');

  // Format evidence for the prompt
  const evidenceText =
    evidence.length > 0
      ? evidence
          .map((e, i) => `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`)
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const prompt = VERDICT_PROMPT.replace('{CLAIM}', claim).replace('{EVIDENCE}', evidenceText);

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openrouterKey}`,
      'HTTP-Referer': 'chrome-extension://aletheia',
      'X-Title': 'Aletheia Fact-Checker',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0, // Deterministic for verdicts
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned empty response for verdict.');
  }

  try {
    const verdict = parseJSON(content);
    // Validate and normalize
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
    // Graceful fallback: return "Unverified" with the raw text as explanation
    return {
      verdict: 'Unverified',
      explanation: 'Could not parse the fact-check result. Raw response: ' + content.slice(0, 200),
      confidence: 'Low',
      key_sources: [],
    };
  }
}
