/**
 * verifyContent.ts: The ONLY module that calls the Aletheia verification backend.
 *
 * Ported from the browser extension's modules/pipeline.js. The three-stage
 * pipeline is identical: extractClaims → retrieveEvidence → generateVerdict.
 *
 * Key differences from the extension version:
 *   - No chrome.storage dependency. Config comes from config.ts.
 *   - All calls go through the proxy with Bearer token auth.
 *   - No direct Tavily/LLM key support (mobile users don't bring their own keys).
 */

import { CONFIG } from './config';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  title: string;
  url: string;
  snippet: string;
}

export interface Verdict {
  verdict: 'True' | 'False' | 'Misleading' | 'Unverified';
  explanation: string;
  confidence: 'High' | 'Medium' | 'Low';
  key_sources: string[];
}

export interface ClaimResult {
  claim: string;
  verdict: Verdict;
}

export interface VerificationResult {
  claims: ClaimResult[];
  rawTranscript: string;
}

// ─── Proxy Helpers ────────────────────────────────────────────────────────────

async function callProxy(path: string, body: Record<string, unknown>): Promise<any> {
  const base = (CONFIG.PROXY_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('The Aletheia proxy is not configured.');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add the Authorization header if a mobile token is available
  if (CONFIG.MOBILE_API_TOKEN) {
    headers['Authorization'] = `Bearer ${CONFIG.MOBILE_API_TOKEN}`;
  }

  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new Error('Aletheia is busy right now (shared quota). Try again shortly.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as any).error || `Proxy error (${res.status})`);
  }
  return res.json();
}

async function callLLM(
  promptText: string,
  temperature = 0.3,
  maxTokens = 2048,
): Promise<string> {
  const data = await callProxy('/v1/chat', {
    messages: [{ role: 'user', content: promptText }],
    temperature,
    max_tokens: maxTokens,
  });
  return data.content;
}

// ─── JSON Parsing ─────────────────────────────────────────────────────────────

function parseJSON(raw: string): any {
  let cleaned = raw.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (_) {}
  }

  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {}
  }

  throw new Error(`Invalid JSON format: ${raw.slice(0, 150)}`);
}

// ─── Stage 1: Claim Extraction ────────────────────────────────────────────────

const CLAIM_EXTRACTION_PROMPT_ID = `Anda adalah asisten pemeriksa fakta profesional. Tugas Anda adalah mengekstrak klaim faktual spesifik yang dapat diverifikasi kebenarannya dari teks berikut.

Aturan:
* Hanya sertakan klaim yang dapat diverifikasi dengan sumber eksternal (statistik, peristiwa, pernyataan tokoh, fakta ilmiah).
* Setiap klaim harus berdiri sendiri dan mudah dipahami tanpa membaca seluruh teks.
* JANGAN menyertakan opini, prediksi, pertanyaan retoris, atau klaim samar.
* Tulis ulang setiap klaim menjadi kalimat yang jelas dan tepat dalam Bahasa Indonesia.
* Batasi hingga 2 to 4 klaim paling signifikan dan penting.
* Berikan hasil HANYA berupa JSON array of strings dalam Bahasa Indonesia. Tanpa penjelasan tambahan, tanpa markdown format.

Contoh output:
["Pertumbuhan PDB Indonesia mencapai 5,1% pada Q3 2025.", "WHO menyatakan mpox sebagai darurat kesehatan global pada Agustus 2024."]`;

const CLAIM_EXTRACTION_PROMPT_EN = `You are a professional fact-checking assistant. Your task is to extract specific, discrete, falsifiable factual claims from the following text.

Rules:
* Only include claims that can be verified against external sources (statistics, events, attributions, scientific statements).
* Each claim must be self-contained (understandable without the surrounding text).
* Do NOT include opinions, predictions, rhetorical questions, or vague statements.
* Rewrite each claim as a clear, concise sentence in English.
* Limit to the 2 to 4 most significant, distinct, and verifiable claims.
* Return ONLY a valid JSON array of strings in English. No explanation, no markdown format.

Example output:
["Indonesia GDP growth reached 5.1% in Q3 2025.", "WHO declared mpox a global health emergency in August 2024."]`;

export async function extractClaims(text: string, lang: 'id' | 'en' = 'id'): Promise<string[]> {
  const truncated =
    text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;
  const basePrompt = lang === 'en' ? CLAIM_EXTRACTION_PROMPT_EN : CLAIM_EXTRACTION_PROMPT_ID;
  const label = lang === 'en' ? 'Text to analyze' : 'Teks yang dianalisis';
  const prompt = basePrompt + `\n\n${label}:\n"""\n${truncated}\n"""`;

  const content = await callLLM(prompt, 0.2, 2048);

  try {
    const claims = parseJSON(content);
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error('Parsed result is not a non-empty array.');
    }
    const filtered = claims.filter(
      (c: any) => typeof c === 'string' && c.trim().length >= 10,
    );
    return filtered.slice(0, 3);
  } catch (parseErr) {
    console.warn(
      '[Aletheia Mobile] Failed to parse claims JSON, attempting line-split fallback:',
      parseErr,
    );
    const lines = content
      .split('\n')
      .map((l: string) => l.replace(/^[\d\-\.\)\*]+\s*/, '').trim())
      .filter((l: string) => l.length >= 10);
    if (lines.length === 0) {
      throw new Error('Could not parse any claims from LLM response.');
    }
    return lines.slice(0, 3);
  }
}

// Stage 2: Evidence Retrieval

export async function retrieveEvidence(claim: string): Promise<EvidenceItem[]> {
  try {
    const data = await callProxy('/v1/search', { query: claim, max_results: 3 });
    return (data.results || []).map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      snippet: r.snippet || '',
    }));
  } catch (err: any) {
    console.warn('[Aletheia Mobile] Evidence retrieval failed:', err.message);
    return [];
  }
}

// Stage 3: Verdict Generation

const VERDICT_PROMPT_ID = `Anda adalah seorang pemeriksa fakta yang independen dan teliti. Evaluasi klaim berikut berdasarkan HANYA bukti bukti yang disediakan di bawah ini. JANGAN menggunakan pengetahuan di luar bukti yang diberikan.

Klaim yang diperiksa:
"{CLAIM}"

Bukti bukti sumber:
{EVIDENCE}

Tuliskan respons Anda HANYA dalam format JSON valid (tanpa blok markdown \`\`\`json, tanpa teks tambahan):
{
  "verdict": "True" | "False" | "Misleading" | "Unverified",
  "explanation": "Penjelasan ringkas 2 sampai 3 kalimat dalam Bahasa Indonesia yang logis dan jelas mengenai alasan verifikasi berdasarkan bukti yang ditemukan.",
  "confidence": "High" | "Medium" | "Low",
  "key_sources": ["url1", "url2"]
}

Aturan Sangat Penting:
* Bidang "explanation" WAJIB ditulis sepenuhnya dalam Bahasa Indonesia yang baku, jelas, dan profesional.
* Bidang "verdict" WAJIB memilih salah satu dari nilai persis berikut: "True", "False", "Misleading", atau "Unverified".
* Bidang "confidence" WAJIB memilih salah satu dari: "High", "Medium", atau "Low".
* Sertakan URL sumber utama yang relevan pada bidang "key_sources".`;

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
* Write the "explanation" value in clear English.
* Keep "verdict" strictly as one of: "True", "False", "Misleading", or "Unverified".
* Keep "confidence" strictly as one of: "High", "Medium", or "Low".
* Include relevant source URLs in "key_sources".`;

export async function generateVerdict(
  claim: string,
  evidence: EvidenceItem[],
  lang: 'id' | 'en' = 'id',
): Promise<Verdict> {
  const evidenceText =
    evidence.length > 0
      ? evidence
          .map(
            (e, i) =>
              `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`,
          )
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const basePrompt = lang === 'en' ? VERDICT_PROMPT_EN : VERDICT_PROMPT_ID;
  const prompt = basePrompt
    .replace('{CLAIM}', claim)
    .replace('{EVIDENCE}', evidenceText);

  const content = await callLLM(prompt, 0.1, 1024);

  try {
    const verdict = parseJSON(content);
    const validVerdicts = ['True', 'False', 'Misleading', 'Unverified'];

    return {
      verdict: validVerdicts.includes(verdict.verdict)
        ? verdict.verdict
        : 'Unverified',
      explanation: verdict.explanation || (lang === 'en' ? 'No explanation provided.' : 'Tidak ada penjelasan yang diberikan.'),
      confidence: verdict.confidence || 'Low',
      key_sources: Array.isArray(verdict.key_sources)
        ? verdict.key_sources
        : [],
    };
  } catch (parseErr) {
    console.warn(
      '[Aletheia Mobile] Failed to parse verdict JSON:',
      parseErr,
      content,
    );
    return {
      verdict: 'Unverified',
      explanation:
        'Could not parse the fact-check result. Raw response: ' +
        content.slice(0, 200),
      confidence: 'Low',
      key_sources: [],
    };
  }
}

// ─── Full Pipeline ────────────────────────────────────────────────────────────

/**
 * Run the complete verification pipeline on a transcript.
 *
 * This is the main entry point for mobile: give it a transcript string,
 * get back structured claim results.
 */
export async function verifyTranscript(
  transcript: string,
  lang: 'id' | 'en' = 'id',
  onProgress?: (status: string) => void,
): Promise<VerificationResult> {
  onProgress?.(lang === 'en' ? 'Verifying claims via Aletheia backend…' : 'Memeriksa klaim via Aletheia backend…');

  try {
    const data = await callProxy('/v1/verify-mobile', { transcript, lang });
    if (data && Array.isArray(data.claims)) {
      return {
        claims: data.claims,
        rawTranscript: transcript,
      };
    }
  } catch (err: any) {
    console.warn(
      '[Aletheia Mobile] Direct /v1/verify-mobile call failed, attempting step-by-step fallback:',
      err.message,
    );
  }

  onProgress?.(lang === 'en' ? 'Extracting factual claims…' : 'Mengekstrak klaim faktual…');
  const claims = await extractClaims(transcript, lang);

  if (claims.length === 0) {
    return { claims: [], rawTranscript: transcript };
  }

  const results: ClaimResult[] = [];

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    onProgress?.(lang === 'en' ? `Checking claim ${i + 1} of ${claims.length}…` : `Memeriksa klaim ${i + 1} dari ${claims.length}…`);

    const evidence = await retrieveEvidence(claim);
    const verdict = await generateVerdict(claim, evidence, lang);
    results.push({ claim, verdict });
  }

  return { claims: results, rawTranscript: transcript };
}
