/**
 * pipeline.js: Shared fact-checking pipeline powered by the hosted LLM proxy.
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
 * Reads legacy personal keys from chrome.storage.sync. New installs use the
 * hosted proxy and do not need to save credentials.
 */
export async function getSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(
      ['llmKey', 'nvidiaKey', 'tavilyKey'],
      (data) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        let llmKey = data.llmKey || '';
        if (!llmKey && data.nvidiaKey) {
          if (data.nvidiaKey.startsWith('nvapi-')) {
            chrome.storage.sync.remove(['nvidiaKey']).catch(() => {});
          } else {
            llmKey = data.nvidiaKey;
          }
        }

        resolve({
          llmKey: llmKey || CONFIG.LLM_API_KEY,
          tavilyKey: data.tavilyKey || CONFIG.TAVILY_API_KEY,
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
 * Call the hosted proxy, which holds provider keys server-side and fails over
 * across a provider chain. This is the default path: it is what lets the
 * extension work on install with nothing configured.
 */
async function callProxy(path, body) {
  const base = (CONFIG.PROXY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('The Aletheia proxy is not configured.');

  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new Error('Aletheia is busy right now (shared quota). Try again shortly.');
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

export async function callLLM(promptText, temperature = 0.3, maxTokens = 2048) {
  const { llmKey } = await getSettings();
  const apiKey = llmKey && llmKey.trim() ? llmKey.trim() : CONFIG.LLM_API_KEY;

  // Try direct key if available and not a legacy nvapi key
  if (apiKey && !apiKey.startsWith('nvapi-')) {
    const url = CONFIG.LLM_DIRECT_URL;
    const modelsToTry = [CONFIG.LLM_DIRECT_MODEL];

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

        if (res.ok) {
          const data = await res.json();
          const content = data.choices?.[0]?.message?.content;
          if (content && content.trim().length > 0) {
            return content;
          }
        } else {
          console.warn(`[Aletheia] Direct LLM API returned status ${res.status}, falling back to proxy.`);
        }
      } catch (err) {
        console.warn(`[Aletheia] Error with direct model ${model}, falling back to proxy:`, err.message);
      }
    }
  }

  // Fallback to hosted proxy (handles provider failover automatically)
  const data = await callProxy('/v1/chat', {
    messages: [{ role: 'user', content: promptText }],
    temperature,
    max_tokens: maxTokens,
  });
  return data.content;
}

// ─── Stage 1: Claim Extraction ────────────────────────────────────────────────

const CLAIM_EXTRACTION_PROMPT_ID = `Anda adalah asisten pemeriksa fakta profesional. Tugas Anda adalah mengekstrak klaim faktual spesifik yang dapat diverifikasi kebenarannya dari teks berikut.

Aturan:
- Hanya sertakan klaim yang dapat diverifikasi dengan sumber eksternal (statistik, peristiwa, pernyataan tokoh, fakta ilmiah).
- Setiap klaim harus berdiri sendiri dan mudah dipahami tanpa membaca seluruh teks.
- JANGAN menyertakan opini, prediksi, pertanyaan retoris, atau klaim samar.
- Tulis ulang setiap klaim menjadi kalimat yang jelas dan tepat dalam Bahasa Indonesia.
- Batasi hingga 2–4 klaim paling signifikan dan penting.
- Berikan hasil HANYA berupa JSON array of strings dalam Bahasa Indonesia. Tanpa penjelasan tambahan, tanpa markdown format.

Contoh output:
["Pertumbuhan PDB Indonesia mencapai 5,1% pada Q3 2025.", "WHO menyatakan mpox sebagai darurat kesehatan global pada Agustus 2024."]`;

const CLAIM_EXTRACTION_PROMPT_EN = `You are a professional fact-checking assistant. Your task is to extract specific, discrete, falsifiable factual claims from the following text.

Rules:
- Only include claims that can be verified against external sources (statistics, events, attributions, scientific statements).
- Each claim must be self-contained (understandable without the surrounding text).
- Do NOT include opinions, predictions, rhetorical questions, or vague statements.
- Rewrite each claim as a clear, concise sentence in English.
- Limit to the 2 to 4 most significant, distinct, and verifiable claims.
- Return ONLY a valid JSON array of strings in English. No explanation, no markdown format.

Example output:
["Indonesia GDP growth reached 5.1% in Q3 2025.", "WHO declared mpox a global health emergency in August 2024."]`;

/**
 * Uses the configured LLM to extract checkable claims from text.
 * @param {string} text  The article body or transcript chunk.
 * @param {'id'|'en'} [lang='id']
 * @returns {Promise<string[]>}  Array of claim strings.
 */
export async function extractClaims(text, lang = 'id') {
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;
  const basePrompt = lang === 'en' ? CLAIM_EXTRACTION_PROMPT_EN : CLAIM_EXTRACTION_PROMPT_ID;
  const label = lang === 'en' ? 'Text to analyze' : 'Teks yang dianalisis';
  const prompt = basePrompt + `\n\n${label}:\n"""\n${truncated}\n"""`;

  const content = await callLLM(prompt, 0.2, 2048);

  try {
    const claims = parseJSON(content);
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error('Parsed result is not a non-empty array.');
    }
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

const VERDICT_PROMPT_ID = `Anda adalah seorang pemeriksa fakta yang independen dan teliti. Evaluasi klaim berikut berdasarkan HANYA bukti-bukti yang disediakan di bawah ini. JANGAN menggunakan pengetahuan di luar bukti yang diberikan.

Klaim yang diperiksa:
"{CLAIM}"

Bukti-bukti sumber:
{EVIDENCE}

Tuliskan respons Anda HANYA dalam format JSON valid (tanpa blok markdown \`\`\`json, tanpa teks tambahan):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Penjelasan ringkas 2 sampai 3 kalimat dalam Bahasa Indonesia yang logis dan jelas mengenai alasan verifikasi berdasarkan bukti yang ditemukan.",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Aturan Sangat Penting:
1. Bidang "explanation" WAJIB ditulis sepenuhnya dalam Bahasa Indonesia yang baku, jelas, dan profesional.
2. Bidang "verdict" WAJIB memilih salah satu dari nilai persis berikut: "True", "False", "Misleading", atau "Unverified".
3. Bidang "confidence" WAJIB memilih salah satu dari: "High", "Medium", atau "Low".
4. Sertakan URL sumber utama yang relevan pada bidang "key_sources".`;

const VERDICT_PROMPT_EN = `You are a rigorous, independent fact-checker. Evaluate the following claim based ONLY on the evidence provided below. Do NOT use your own training knowledge. Ground your verdict strictly in the supplied sources.

Claim:
"{CLAIM}"

Evidence:
{EVIDENCE}

Respond with ONLY valid JSON (no markdown fences, no extra text):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Write a 2 to 3 sentence explanation of your reasoning in clear, natural English, referencing specific sources",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Important:
1. Write the "explanation" value in clear English.
2. Keep "verdict" strictly as one of: "True", "False", "Misleading", or "Unverified".
3. Keep "confidence" strictly as one of: "High", "Medium", or "Low".
4. Include relevant source URLs in "key_sources".`;

/**
 * Generates a grounded verdict for a single claim.
 * @param {string} claim
 * @param {Array<{title: string, url: string, snippet: string}>} evidence
 * @param {'id'|'en'} [lang='id']
 * @returns {Promise<{verdict: string, explanation: string, confidence: string, key_sources: string[]}>}
 */
export async function generateVerdict(claim, evidence, lang = 'id') {
  const evidenceText =
    evidence.length > 0
      ? evidence
          .map((e, i) => `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`)
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const basePrompt = lang === 'en' ? VERDICT_PROMPT_EN : VERDICT_PROMPT_ID;
  const prompt = basePrompt.replace('{CLAIM}', claim).replace('{EVIDENCE}', evidenceText);

  const content = await callLLM(prompt, 0.1, 1024);

  try {
    const verdict = parseJSON(content);
    const validVerdicts = ['True', 'False', 'Misleading', 'Unverified'];
    if (!validVerdicts.includes(verdict.verdict)) {
      verdict.verdict = 'Unverified';
    }
    return {
      verdict: verdict.verdict,
      explanation: verdict.explanation || (lang === 'en' ? 'No explanation provided.' : 'Tidak ada penjelasan yang diberikan.'),
      confidence: verdict.confidence || 'Low',
      key_sources: Array.isArray(verdict.key_sources) ? verdict.key_sources : [],
    };
  } catch (parseErr) {
    console.warn('[Aletheia] Failed to parse verdict JSON:', parseErr, content);
    return {
      verdict: 'Unverified',
      explanation: (lang === 'en' ? 'Could not parse the fact-check result.' : 'Tidak dapat memproses hasil pemeriksaan fakta.'),
      confidence: 'Low',
      key_sources: [],
    };
  }
}
