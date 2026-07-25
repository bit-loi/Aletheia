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
      ['openrouterKey', 'geminiKey', 'tavilyKey', 'deepgramKey', 'model'],
      (data) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve({
          openrouterKey: data.openrouterKey || '',
          geminiKey: data.geminiKey || '',
          tavilyKey: data.tavilyKey || '',
          deepgramKey: data.deepgramKey || '',
          model: data.model || 'google/gemini-2.0-flash',
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

const FREE_MODEL_FALLBACKS = [
  'google/gemma-4-31b-it:free',
  'google/gemini-2.0-flash-exp:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
  'deepseek/deepseek-r1:free',
];

/**
 * Calls Google Gemini REST API directly using an AI Studio API key (AIzaSy... or AQ...).
 */
async function callGeminiAPI(geminiKey, modelName, promptText, temperature = 0.1, maxTokens = 1024) {
  let primaryModel = 'gemini-2.0-flash';
  if (modelName && modelName.includes('1.5-pro')) {
    primaryModel = 'gemini-1.5-pro';
  } else if (modelName && modelName.includes('1.5-flash')) {
    primaryModel = 'gemini-1.5-flash';
  } else if (modelName && modelName.includes('pro')) {
    primaryModel = 'gemini-1.5-pro';
  }

  const modelsToTry = [primaryModel, 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const uniqueModels = [...new Set(modelsToTry)];

  let lastError = null;

  for (const m of uniqueModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: temperature,
            maxOutputTokens: maxTokens,
          },
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Google Gemini API error (${res.status}): ${errBody.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Gemini API returned an empty text response.');
      }
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`[Aletheia] Gemini model ${m} failed, trying fallback:`, err.message);
    }
  }

  throw lastError || new Error('All Gemini API model attempts failed.');
}

/**
 * Call OpenRouter API with automatic fallback for free models on HTTP 429 rate limits.
 */
async function callLLMWithFallback(openrouterKey, model, messages, temperature = 0.1, maxTokens = 1024) {
  const modelsToTry = [model];
  if (model.endsWith(':free')) {
    FREE_MODEL_FALLBACKS.forEach((m) => {
      if (!modelsToTry.includes(m)) modelsToTry.push(m);
    });
  }

  let lastError = null;

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModel = modelsToTry[i];
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openrouterKey}`,
          'HTTP-Referer': 'chrome-extension://aletheia',
          'X-Title': 'Aletheia Fact-Checker',
        },
        body: JSON.stringify({
          model: currentModel,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      });

      if (res.status === 429 && i < modelsToTry.length - 1) {
        console.warn(`[Aletheia] Model ${currentModel} rate limited (429), trying fallback ${modelsToTry[i + 1]}...`);
        lastError = new Error(`OpenRouter API error (429): Model ${currentModel} is rate-limited.`);
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`OpenRouter API error (${res.status}): ${errBody.slice(0, 200)}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM returned empty response.');
      }
      return content;
    } catch (err) {
      lastError = err;
      if (!currentModel.endsWith(':free') || (err.message && !err.message.includes('429'))) {
        throw err;
      }
    }
  }

  throw lastError || new Error('All model fallback attempts failed.');
}

/**
 * High-level LLM router: prefers direct Gemini API if geminiKey is set,
 * otherwise falls back to OpenRouter with model fallbacks.
 */
async function callLLM(prompt, temperature = 0.1, maxTokens = 1024) {
  const { openrouterKey, geminiKey, model } = await getSettings();

  if (geminiKey && geminiKey.trim()) {
    console.log('[Aletheia] Calling direct Google Gemini API (AI Studio)...');
    return await callGeminiAPI(geminiKey.trim(), model, prompt, temperature, maxTokens);
  }

  if (openrouterKey && openrouterKey.trim()) {
    console.log('[Aletheia] Calling OpenRouter API...');
    return await callLLMWithFallback(
      openrouterKey.trim(),
      model,
      [{ role: 'user', content: prompt }],
      temperature,
      maxTokens
    );
  }

  throw new Error(
    'No LLM API Key set. Please enter your Google Gemini API Key (AI Studio) or OpenRouter API Key in the extension popup.'
  );
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
  // Truncate extremely long texts to avoid blowing context window / cost.
  // ~12 000 chars ≈ 3 000 tokens, which is plenty for claim extraction.
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;

  const prompt = CLAIM_EXTRACTION_PROMPT.replace('{TEXT}', truncated);

  const content = await callLLM(prompt, 0.1, 1024);

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
 * Calls Tavily Search API to retrieve ground-truth snippets for a claim.
 * @param {string} claim
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function retrieveEvidence(claim) {
  const { tavilyKey } = await getSettings();

  // If Tavily key is omitted, degrade gracefully (verdicts will be Unverified)
  if (!tavilyKey) {
    return [];
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
 * Generates a grounded verdict for a single claim.
 * @param {string} claim
 * @param {Array<{title: string, url: string, snippet: string}>} evidence
 * @returns {Promise<{verdict: string, explanation: string, confidence: string, key_sources: string[]}>}
 */
export async function generateVerdict(claim, evidence) {
  // Format evidence for the prompt
  const evidenceText =
    evidence.length > 0
      ? evidence
          .map((e, i) => `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`)
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const prompt = VERDICT_PROMPT.replace('{CLAIM}', claim).replace('{EVIDENCE}', evidenceText);

  const content = await callLLM(prompt, 0.0, 512);

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
