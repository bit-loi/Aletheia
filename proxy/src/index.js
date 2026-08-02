/**
 * Aletheia proxy.
 *
 * Holds the API keys server-side so the extension ships with none. A key
 * bundled into an extension is a published key: the package is a zip, anyone
 * can read it out of their own profile directory, and the quota is then
 * everyone's. This Worker exists so users can install and go.
 *
 * The mobile app has the same problem and the same answer, but it cannot prove
 * itself with an Origin header, so it presents a shared bearer token instead.
 *
 * Endpoints
 *   POST /v1/chat            OpenAI-shaped chat completion
 *   POST /v1/search          evidence search
 *   POST /v1/transcribe      audio clip -> transcript (Gemini native, mobile)
 *   POST /v1/verify-mobile   transcript -> claims -> evidence -> verdict
 *   POST /v1/gemini-live-token short-lived browser credential for live audio
 *   GET  /health             liveness
 *
 * Every endpoint except /health requires either an allowed Origin or a valid
 * mobile bearer token.
 *
 * Bindings (see wrangler.jsonc)
 *   env.RL               rate limiter
 *   env.ALLOWED_ORIGINS  comma-separated chrome-extension:// origins; supports
 *                        chrome-extension://* for unpacked installs
 *   env.LLM_CHAIN        comma-separated provider ids, in preference order
 *   env.GEMINI_TRANSCRIBE_MODEL  model for /v1/transcribe
 *   env.GEMINI_API_KEY / env.OPENROUTER_API_KEY / env.GROQ_API_KEY /
 *   env.TAVILY_API_KEY / env.MOBILE_API_TOKEN  (secrets)
 */

/**
 * Provider chain. Every entry speaks the OpenAI /chat/completions shape, so
 * failing over between them costs nothing but a base URL and a model id.
 *
 * This is what makes the fabricated-claims fallback in the extension
 * unnecessary: when one free tier is busy, another answers, and the pipeline
 * never has to invent a claim to keep the UI looking alive.
 */
const PROVIDERS = {
  /**
   * Gemini via Google's OpenAI-compatibility layer, so it uses the same request
   * shape as every other entry here. The native generateContent API does not,
   * and would need its own adapter.
   *
   * Model id is a var rather than a literal so switching models does not
   * require a code change.
   */
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: (env) => env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    key: (env) => env.GEMINI_API_KEY,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: (env) => env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free',
    key: (env) => env.OPENROUTER_API_KEY,
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'minimaxai/minimax-m3',
    key: (env) => env.NVIDIA_API_KEY,
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    key: (env) => env.GROQ_API_KEY,
  },
  pollinations: {
    url: 'https://text.pollinations.ai/openai',
    model: 'openai-fast',
    key: (env) => env.POLLINATIONS_API_KEY,
  },
};

const MAX_BODY_BYTES = 128 * 1024; // articles are text; anything larger is abuse
// Audio is the one route that legitimately exceeds the text cap. A 15 s 16 kHz
// mono PCM16 WAV is ~480 KB raw and ~640 KB base64; 2 MB leaves headroom for a
// longer or higher-rate clip without inviting uploads of arbitrary files.
const MAX_AUDIO_BODY_BYTES = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 25000;

/** Audio container types Gemini accepts as inline_data. */
const TRANSCRIBE_MIME_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/mp3',
  'audio/mpeg',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
]);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, x-aletheia-client',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin || '*') },
  });
}

/**
 * Allow-list the caller's Origin.
 *
 * Honest limitation: Origin is set by browsers but trivially forged by any
 * non-browser client, so this is friction against casual abuse, not
 * authentication. The per-IP rate limit is what actually bounds cost. If this
 * ever needs to be real, issue per-install tokens and verify them here.
 */
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isChromeExtension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  const matches = allowed.includes(origin) ||
    (allowed.includes('chrome-extension://*') && isChromeExtension);
  return matches ? origin : null;
}

/**
 * Authenticate mobile clients via a shared bearer token or custom header.
 *
 * React Native's fetch() does not send an Origin header. Mobile clients send
 * `X-Aletheia-Client: <MOBILE_API_TOKEN>` or `Authorization: Bearer <MOBILE_API_TOKEN>`
 * and receive CORS headers.
 *
 * The token is set as a Cloudflare secret:
 *   wrangler secret put MOBILE_API_TOKEN
 */
function isMobileAuthed(request, env) {
  const token = env.MOBILE_API_TOKEN || env.MOBILE_CLIENT_TOKEN;
  if (!token) return false;

  const customHeader = request.headers.get('X-Aletheia-Client') || request.headers.get('x-aletheia-client') || '';
  if (customHeader === token) return true;

  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return !!(match && match[1] === token);
}

/**
 * Read a JSON body with a hard size cap.
 *
 * The cap is per route rather than global: text routes stay tight because
 * anything larger than an article is abuse, while /v1/transcribe has to carry
 * base64 audio, which is inherently ~1.4 MB for a 15 s 16 kHz mono recording.
 */
async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('payload too large');
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('payload too large');
  return JSON.parse(text);
}

async function callProvider(provider, env, payload) {
  const key = provider.key(env);
  if (!key) return { ok: false, status: 503, detail: 'provider not configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: typeof provider.model === 'function' ? provider.model(env) : provider.model,
        messages: payload.messages,
        temperature: payload.temperature ?? 0.2,
        max_tokens: Math.min(payload.max_tokens ?? 2048, 4096),
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Deliberately not forwarding the upstream body: provider errors can echo
      // request headers and leak which key was used.
      return { ok: false, status: res.status, detail: `upstream ${res.status}` };
    }
    // Bounded by max_tokens above, so buffering here is safe.
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, status: 502, detail: 'empty completion' };
    return { ok: true, content };
  } catch (err) {
    return { ok: false, status: 504, detail: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function handleChat(request, env, origin) {
  const payload = await readJson(request);
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return json({ error: 'messages[] required' }, 400, origin);
  }

  const chain = (env.LLM_CHAIN || 'nvidia')
    .split(',')
    .map((s) => s.trim())
    .filter((id) => PROVIDERS[id]);

  const attempts = [];
  for (const id of chain) {
    const result = await callProvider(PROVIDERS[id], env, payload);
    if (result.ok) {
      return json({ content: result.content, provider: id }, 200, origin);
    }
    attempts.push({ provider: id, status: result.status, detail: result.detail });
    console.log(JSON.stringify({ event: 'provider_failed', provider: id, detail: result.detail }));
  }

  // Every provider failed. Say so plainly. The caller must surface this as an
  // error, never as a verdict.
  return json({ error: 'all providers unavailable', attempts }, 503, origin);
}

/** Strip the HTML Wikipedia returns inside search snippets. */
function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Search backends, tried in SEARCH_CHAIN order. Same pattern as the LLM chain:
 * when one runs out of quota mid-demo the next answers, rather than the whole
 * verdict step failing.
 */
const SEARCH_PROVIDERS = {
  /**
   * Self-hosted SearXNG. No key, no quota.
   *
   * Requires two things in the instance's settings.yml, neither of which is the
   * default:
   *   search.formats: [html, json]   - JSON output is off by default, and
   *                                    without it this returns HTTP 403
   *   server.limiter: false          - the bot limiter blocks API traffic
   * See proxy/searxng/README.md.
   */
  async searxng(query, max, env, signal) {
    const base = (env.SEARXNG_URL || '').replace(/\/$/, '');
    if (!base) return null;
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`;
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
    if (!res.ok) {
      // 403 here almost always means json is missing from search.formats.
      throw new Error(`searxng ${res.status}`);
    }
    const data = await res.json();
    return (data.results || []).slice(0, max).map((r) => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      snippet: r.content || '',
    }));
  },

  async tavily(query, max, env, signal) {
    if (!env.TAVILY_API_KEY) return null;
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: max,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  },

  /**
   * Wikipedia. No key, no quota, and a citation a media-literacy audience
   * respects. Not general web search, so it is last: good on historical,
   * scientific and statistical claims, useless on breaking news.
   */
  async wikipedia(query, max, _env, signal) {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*' +
      `&srlimit=${max}&srsearch=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`wikipedia ${res.status}`);
    const data = await res.json();
    return (data?.query?.search || []).map((r) => ({
      title: r.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      snippet: stripTags(r.snippet),
    }));
  },
};

async function handleSearch(request, env, origin) {
  const payload = await readJson(request);
  const query = typeof payload.query === 'string' ? payload.query.trim().slice(0, 400) : '';
  if (!query) return json({ error: 'query required' }, 400, origin);

  const max = Math.min(payload.max_results ?? 5, 10);
  const chain = (env.SEARCH_CHAIN || 'searxng,tavily,wikipedia')
    .split(',')
    .map((s) => s.trim())
    .filter((id) => SEARCH_PROVIDERS[id]);

  const attempts = [];
  for (const id of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const results = await SEARCH_PROVIDERS[id](query, max, env, controller.signal);
      if (results === null) {
        attempts.push({ provider: id, detail: 'not configured' });
        continue;
      }
      if (results.length) return json({ results, provider: id }, 200, origin);
      attempts.push({ provider: id, detail: 'no results' });
    } catch (err) {
      const detail = err.name === 'AbortError' ? 'timeout' : err.message;
      attempts.push({ provider: id, detail });
      console.log(JSON.stringify({ event: 'search_failed', provider: id, detail }));
    } finally {
      clearTimeout(timer);
    }
  }

  // Empty results are a legitimate outcome, not an error: a claim with no
  // supporting evidence must reach the model as "no evidence", so it returns
  // Unverified rather than inventing support.
  return json({ results: [], attempts }, 200, origin);
}

/**
 * Mint a short-lived Gemini Live credential so tab audio can travel directly
 * from the extension to Google's WebSocket without exposing the permanent key.
 */
async function handleGeminiLiveToken(env, origin) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'Gemini Live is not configured' }, 503, origin);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const now = Date.now();
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
        accept: 'application/json',
      },
      body: JSON.stringify({
        uses: 1,
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        expireTime: new Date(now + 20 * 60 * 1000).toISOString(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.log(JSON.stringify({ event: 'gemini_live_token_failed', status: response.status }));
      return json({ error: 'Gemini Live is unavailable' }, 502, origin);
    }
    const data = await response.json();
    if (!data.name) return json({ error: 'Gemini returned no live token' }, 502, origin);
    return json({ token: data.name }, 200, origin);
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'timeout' : 'network';
    console.log(JSON.stringify({ event: 'gemini_live_token_failed', detail }));
    return json({ error: 'Gemini Live is unavailable' }, 502, origin);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe a recorded audio clip.
 *
 * Mobile records a whole 15 s clip and uploads it once, rather than holding the
 * streaming Gemini Live socket the extension uses, because a phone backgrounds
 * the app the moment the user switches to TikTok.
 *
 * This deliberately calls Gemini's native generateContent rather than the
 * OpenAI-compatible /chat/completions the rest of the chain shares: inline_data
 * is the documented way to send audio, whereas the compatibility layer models
 * text-only chat. That is also why this route does not participate in the
 * provider failover chain — OpenRouter and Groq speak the OpenAI shape and have
 * no equivalent audio surface here.
 */
async function handleTranscribe(request, env, origin) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'transcription is not configured' }, 503, origin);
  }

  const payload = await readJson(request, MAX_AUDIO_BODY_BYTES);
  const audio = payload.audio || payload.data;
  const mimeType = (payload.mimeType || payload.mime_type || 'audio/wav').toLowerCase();

  if (!audio || typeof audio !== 'string') {
    return json({ error: 'audio (base64) required' }, 400, origin);
  }
  if (!TRANSCRIBE_MIME_TYPES.has(mimeType)) {
    return json({ error: `unsupported audio type: ${mimeType}` }, 400, origin);
  }

  const model = env.GEMINI_TRANSCRIBE_MODEL || 'gemini-2.5-flash';
  const prompt =
    'Transcribe the following audio exactly as spoken. Return ONLY the raw ' +
    'transcript text: no formatting, no timestamps, no speaker labels, no ' +
    'commentary. If the audio is silent or unintelligible, return exactly [inaudible].';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
          accept: 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audio } }],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 4096 },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      // Same reasoning as callProvider: never forward the upstream body.
      console.log(JSON.stringify({ event: 'transcribe_failed', status: response.status }));
      return json({ error: 'transcription is unavailable' }, 502, origin);
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.map((p) => p.text || '').join('').trim()
      : '';

    // An empty or [inaudible] result is a real outcome, not an error: the caller
    // needs to tell the user to unplug headphones rather than invent a claim.
    return json({ transcript: text, model, inaudible: !text || text === '[inaudible]' }, 200, origin);
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'timeout' : 'network';
    console.log(JSON.stringify({ event: 'transcribe_failed', detail }));
    return json({ error: 'transcription is unavailable' }, 502, origin);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Verification Pipeline for Mobile ────────────────────────────────────────

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

function parseJSON(raw) {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

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

async function workerCallLLM(promptText, env, temperature = 0.2, maxTokens = 2048) {
  const chain = (env.LLM_CHAIN || 'nvidia')
    .split(',')
    .map((s) => s.trim())
    .filter((id) => PROVIDERS[id]);

  const payload = {
    messages: [{ role: 'user', content: promptText }],
    temperature,
    max_tokens: maxTokens,
  };

  for (const id of chain) {
    const result = await callProvider(PROVIDERS[id], env, payload);
    if (result.ok) return result.content;
  }
  throw new Error('All LLM providers unavailable');
}

async function workerSearch(query, env, maxResults = 3) {
  const chain = (env.SEARCH_CHAIN || 'searxng,tavily,wikipedia')
    .split(',')
    .map((s) => s.trim())
    .filter((id) => SEARCH_PROVIDERS[id]);

  for (const id of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const results = await SEARCH_PROVIDERS[id](query, maxResults, env, controller.signal);
      if (results && results.length > 0) {
        return results;
      }
    } catch (err) {
      console.log(JSON.stringify({ event: 'worker_search_failed', provider: id, error: err.message }));
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

const WORKER_CLAIM_EXTRACTION_PROMPT_ID = `Anda adalah asisten pemeriksa fakta profesional. Tugas Anda adalah mengekstrak klaim faktual spesifik yang dapat diverifikasi kebenarannya dari teks berikut.

Aturan:
- Hanya sertakan klaim yang dapat diverifikasi dengan sumber eksternal (statistik, peristiwa, pernyataan tokoh, fakta ilmiah).
- Setiap klaim harus berdiri sendiri dan mudah dipahami tanpa membaca seluruh teks.
- JANGAN menyertakan opini, prediksi, pertanyaan retoris, atau klaim samar.
- Tulis ulang setiap klaim menjadi kalimat yang jelas dan tepat dalam Bahasa Indonesia.
- Batasi hingga 2–4 klaim paling signifikan dan penting.
- Berikan hasil HANYA berupa JSON array of strings dalam Bahasa Indonesia. Tanpa penjelasan tambahan, tanpa markdown format.`;

const WORKER_CLAIM_EXTRACTION_PROMPT_EN = `You are a professional fact-checking assistant. Your task is to extract specific, discrete, falsifiable factual claims from the following text.

Rules:
- Only include claims that can be verified against external sources (statistics, events, attributions, scientific statements).
- Each claim must be self-contained (understandable without the surrounding text).
- Do NOT include opinions, predictions, rhetorical questions, or vague statements.
- Rewrite each claim as a clear, concise sentence in English.
- Limit to the 2 to 4 most significant, distinct, and verifiable claims.
- Return ONLY a valid JSON array of strings in English. No explanation, no markdown format.`;

async function workerExtractClaims(text, env, lang = 'id') {
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;
  const basePrompt = lang === 'en' ? WORKER_CLAIM_EXTRACTION_PROMPT_EN : WORKER_CLAIM_EXTRACTION_PROMPT_ID;
  const label = lang === 'en' ? 'Text to analyze' : 'Teks yang dianalisis';
  const prompt = basePrompt + `\n\n${label}:\n"""\n${truncated}\n"""`;
  const content = await workerCallLLM(prompt, env, 0.2, 2048);

  try {
    const claims = parseJSON(content);
    if (Array.isArray(claims) && claims.length > 0) {
      const filtered = claims.filter((c) => typeof c === 'string' && c.trim().length >= 10);
      if (filtered.length > 0) return filtered.slice(0, 3);
    }
  } catch (_) {}

  const lines = content
    .split('\n')
    .map((l) => l.replace(/^[\d\-\.\)\*]+\s*/, '').trim())
    .filter((l) => l.length >= 10);
  return lines.slice(0, 3);
}

const WORKER_VERDICT_PROMPT_ID = `Anda adalah seorang pemeriksa fakta yang independen dan teliti. Evaluasi klaim berikut berdasarkan HANYA bukti-bukti yang disediakan di bawah ini. JANGAN menggunakan pengetahuan di luar bukti yang diberikan.

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
}`;

const WORKER_VERDICT_PROMPT_EN = `You are a rigorous, independent fact-checker. Evaluate the following claim based ONLY on the evidence provided below. Do NOT use your own training knowledge. Ground your verdict strictly in the supplied sources.

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
}`;

async function workerGenerateVerdict(claim, evidence, env, lang = 'id') {
  const evidenceText =
    evidence.length > 0
      ? evidence
          .map((e, i) => `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`)
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const basePrompt = lang === 'en' ? WORKER_VERDICT_PROMPT_EN : WORKER_VERDICT_PROMPT_ID;
  const prompt = basePrompt.replace('{CLAIM}', claim).replace('{EVIDENCE}', evidenceText);
  const content = await workerCallLLM(prompt, env, 0.1, 1024);

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
  } catch (_) {
    return {
      verdict: 'Unverified',
      explanation: lang === 'en' ? 'Could not parse the fact-check result.' : 'Tidak dapat memproses hasil pemeriksaan fakta.',
      confidence: 'Low',
      key_sources: [],
    };
  }
}

async function handleVerifyMobile(request, env, origin) {
  const payload = await readJson(request);
  const lang = payload.lang === 'en' ? 'en' : 'id';
  let text = payload.text || payload.claimText || payload.claim;
  if (!text && (payload.transcript || payload.ocrText)) {
    const parts = [];
    if (payload.transcript) parts.push(`[Audio Transcript]:\n${payload.transcript.trim()}`);
    if (payload.ocrText) parts.push(`[Screen Text / OCR]:\n${payload.ocrText.trim()}`);
    text = parts.join('\n\n');
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    return json({ error: 'text, claim, transcript, or ocrText required' }, 400, origin);
  }

  const claims = await workerExtractClaims(text, env, lang);
  if (claims.length === 0) {
    return json({
      verdict: 'Unverified',
      confidence: 'Low',
      explanation: lang === 'en' ? 'No verifiable factual claims were found in the context.' : 'Tidak ada klaim faktual yang dapat diverifikasi dalam konteks ini.',
      sources: [],
      claims: [],
    }, 200, origin);
  }

  const results = [];
  for (const claim of claims) {
    const evidence = await workerSearch(claim, env, 3);
    const verdict = await workerGenerateVerdict(claim, evidence, env, lang);
    results.push({ claim, verdict });
  }

  const primary = results[0].verdict;
  return json({
    verdict: primary.verdict,
    confidence: primary.confidence,
    explanation: primary.explanation,
    sources: primary.key_sources,
    claims: results,
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: corsHeaders('*') });
    }

    // Two ways in: a browser extension's Origin, or a mobile bearer token.
    // React Native sends no Origin at all, so an authenticated mobile caller
    // gets '*' echoed back — safe because native HTTP stacks do not enforce
    // CORS, and the token, not the header, is what gates the request.
    //
    // The fallback here must be null, not '*'. Anything truthy makes the 403
    // below unreachable and turns the Worker into an open Gemini/Tavily relay
    // on our keys.
    const origin = allowedOrigin(request, env);
    const mobileAuthed = isMobileAuthed(request, env);
    const effectiveOrigin = origin || (mobileAuthed ? (request.headers.get('Origin') || '*') : null);

    if (request.method === 'OPTIONS') {
      // A browser preflight cannot carry the bearer token, so admit any
      // preflight that announces the mobile header. The request that follows
      // is still gated on the token itself.
      const reqHeaders = request.headers.get('Access-Control-Request-Headers') || '';
      const isMobilePreflight = reqHeaders.toLowerCase().includes('x-aletheia-client');
      const allowOptions = Boolean(effectiveOrigin) || isMobilePreflight;
      return new Response(null, {
        status: allowOptions ? 204 : 403,
        headers: corsHeaders(allowOptions ? (request.headers.get('Origin') || '*') : ''),
      });
    }

    if (!effectiveOrigin) {
      return json({ error: 'origin not allowed' }, 403, null);
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, effectiveOrigin);
    }

    if (env.RL && typeof env.RL.limit === 'function') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RL.limit({ key: ip });
      if (!success) {
        return json({ error: 'rate limited', retryAfter: 60 }, 429, effectiveOrigin);
      }
    } else {
      console.log(JSON.stringify({ event: 'rate_limiter_missing' }));
    }

    try {
      if (url.pathname === '/v1/chat') return await handleChat(request, env, effectiveOrigin);
      if (url.pathname === '/v1/search') return await handleSearch(request, env, effectiveOrigin);
      if (url.pathname === '/v1/transcribe') return await handleTranscribe(request, env, effectiveOrigin);
      if (url.pathname === '/v1/verify-mobile') return await handleVerifyMobile(request, env, effectiveOrigin);
      if (url.pathname === '/v1/gemini-live-token') return await handleGeminiLiveToken(env, effectiveOrigin);
      return json({ error: 'not found' }, 404, effectiveOrigin);
    } catch (err) {
      // An oversized body is the caller's mistake, not ours; say which.
      if (err.message === 'payload too large') {
        return json({ error: 'payload too large' }, 413, effectiveOrigin);
      }
      console.log(JSON.stringify({ event: 'unhandled', message: err.message }));
      return json({ error: 'proxy error' }, 500, effectiveOrigin);
    }
  },
};
