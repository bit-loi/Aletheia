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
 *   env.TRANSCRIBE_CHAIN comma-separated audio provider ids
 *   env.AI               Cloudflare Workers AI binding used as audio fallback
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
const DEFAULT_LLM_CHAIN = 'gemini,openrouter,groq';
const DEFAULT_TRANSCRIBE_CHAIN = 'gemini,workers_ai';
const DEFAULT_WORKERS_AI_TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo';
const TRANSCRIBE_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

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
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error('payload too large');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid json');
  }
}

function configuredChain(raw, fallback, providers) {
  return (raw || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter((id) => providers.includes(id));
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

  const chain = configuredChain(env.LLM_CHAIN, DEFAULT_LLM_CHAIN, Object.keys(PROVIDERS));

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
  const payload = await readJson(request, MAX_AUDIO_BODY_BYTES);
  const audio = payload.audio || payload.data;
  const mimeType = (payload.mimeType || payload.mime_type || 'audio/wav').toLowerCase();

  if (!audio || typeof audio !== 'string') {
    return json({ error: 'audio (base64) required' }, 400, origin);
  }
  if (!TRANSCRIBE_MIME_TYPES.has(mimeType)) {
    return json({ error: `unsupported audio type: ${mimeType}` }, 400, origin);
  }

  const prompt =
    'Transcribe the following audio exactly as spoken. Return ONLY the raw ' +
    'transcript text: no formatting, no timestamps, no speaker labels, no ' +
    'commentary. If the audio is silent or unintelligible, return exactly [inaudible].';

  const chain = configuredChain(
    env.TRANSCRIBE_CHAIN,
    DEFAULT_TRANSCRIBE_CHAIN,
    ['gemini', 'workers_ai'],
  );
  const attempts = [];
  let anyConfigured = false;

  for (const provider of chain) {
    if (provider === 'gemini') {
      if (!env.GEMINI_API_KEY) continue;
      anyConfigured = true;
      const result = await transcribeWithGemini(audio, mimeType, prompt, env);
      attempts.push(...result.attempts);
      if (result.ok) {
        return transcriptionResponse(result.transcript, 'gemini', result.model, origin);
      }
    }

    if (provider === 'workers_ai') {
      if (!env.AI || typeof env.AI.run !== 'function') continue;
      anyConfigured = true;
      const result = await transcribeWithWorkersAI(audio, env);
      attempts.push(result.attempt);
      if (result.ok) {
        return transcriptionResponse(result.transcript, 'workers_ai', result.model, origin);
      }
    }
  }

  console.log(JSON.stringify({ event: 'transcribe_unavailable', attempts }));
  return json(
    { error: anyConfigured ? 'transcription is unavailable' : 'transcription is not configured' },
    anyConfigured ? 502 : 503,
    origin,
  );
}

function transcriptionResponse(transcript, provider, model, origin) {
  const text = String(transcript || '').trim();
  const inaudible = !text || /^\[inaudible\]$/i.test(text);
  return json({ transcript: inaudible ? '' : text, provider, model, inaudible }, 200, origin);
}

function boundedRetryDelay(response, retryIndex, env) {
  const configuredBase = Number(env.TRANSCRIBE_RETRY_BASE_MS || 250);
  const base = Number.isFinite(configuredBase) && configuredBase >= 0
    ? Math.min(configuredBase, 1000)
    : 250;
  const retryAfter = Number(response.headers.get('retry-after'));
  const serverDelay = Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1000, 1000)
    : 0;
  const jitter = Math.floor(Math.random() * Math.max(1, base));
  return Math.min(1000, Math.max(serverDelay, base * (2 ** retryIndex) + jitter));
}

async function transcribeWithGemini(audio, mimeType, prompt, env) {
  const model = env.GEMINI_TRANSCRIBE_MODEL || 'gemini-2.5-flash';
  const configuredAttempts = Number(env.GEMINI_TRANSCRIBE_ATTEMPTS || 2);
  const maxAttempts = Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.min(Math.floor(configuredAttempts), 3))
    : 2;
  const attempts = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
            contents: [{
              role: 'user',
              parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audio } }],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 4096 },
          }),
          signal: controller.signal,
        },
      );

      if (response.ok) {
        const data = await response.json();
        const parts = data?.candidates?.[0]?.content?.parts;
        const transcript = Array.isArray(parts)
          ? parts.map((part) => part.text || '').join('').trim()
          : '';
        return { ok: true, transcript, model, attempts };
      }

      attempts.push({ provider: 'gemini', status: response.status });
      if (!TRANSCRIBE_RETRYABLE_STATUSES.has(response.status) || attempt + 1 >= maxAttempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, boundedRetryDelay(response, attempt, env)));
    } catch (err) {
      const detail = err.name === 'AbortError' ? 'timeout' : 'network';
      attempts.push({ provider: 'gemini', detail });
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, model, attempts };
}

async function transcribeWithWorkersAI(audio, env) {
  const model = env.WORKERS_AI_TRANSCRIBE_MODEL || DEFAULT_WORKERS_AI_TRANSCRIBE_MODEL;
  try {
    const data = await env.AI.run(model, {
      audio,
      task: 'transcribe',
      vad_filter: true,
      condition_on_previous_text: false,
    });
    return { ok: true, transcript: data?.text || '', model, attempt: { provider: 'workers_ai', status: 200 } };
  } catch (err) {
    return {
      ok: false,
      model,
      attempt: { provider: 'workers_ai', detail: err?.name || 'upstream' },
    };
  }
}

// ─── Verification Pipeline for Mobile ────────────────────────────────────────

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
  const chain = configuredChain(env.LLM_CHAIN, DEFAULT_LLM_CHAIN, Object.keys(PROVIDERS));

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

const WORKER_LANGUAGES = {
  id: { name: 'Bahasa Indonesia', label: 'Teks yang dianalisis' },
  en: { name: 'English', label: 'Text to analyze' },
  ja: { name: 'Japanese', label: '分析対象テキスト' },
  ko: { name: 'Korean', label: '분석할 텍스트' },
  zh: { name: 'Simplified Chinese', label: '待分析文本' },
  ar: { name: 'Arabic', label: 'النص المراد تحليله' },
  es: { name: 'Spanish', label: 'Texto a analizar' },
  pt: { name: 'Portuguese', label: 'Texto para analisar' },
  jv: { name: 'Javanese', label: 'Teks kanggo dianalisis' },
  su: { name: 'Sundanese', label: 'Teks anu dianalisis' },
};

function genericClaimPrompt(languageName) {
  return `You are a professional fact-checking assistant. Extract only specific, self-contained, falsifiable factual claims that can be checked against external sources. Exclude opinions, predictions, rhetorical questions, vague statements, and trivial observations. Rewrite each claim clearly in ${languageName}. Return ONLY a valid JSON array containing at most 3 strings in ${languageName}; no markdown or explanation.`;
}

function genericVerdictPrompt(languageName) {
  return `You are a rigorous, independent fact-checker. Evaluate the claim using ONLY the supplied evidence. Do not use training knowledge. Respond ONLY with valid JSON using this shape: {"verdict":"True|False|Misleading|Unverified","explanation":"2 to 3 sentences in ${languageName}","confidence":"High|Medium|Low","key_sources":["URL from the evidence"]}. Use only exact URLs present in the evidence.`;
}

function isCheckableTranscript(text) {
  const normalized = String(text || '').normalize('NFKC').trim();
  const meaningful = normalized.match(/[\p{L}\p{N}]/gu) || [];
  if (meaningful.length < 8) return false;
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(normalized)) {
    return true;
  }
  const tokens = normalized
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  return tokens.length >= 3;
}

async function workerExtractClaims(text, env, lang = 'id') {
  const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n[…text truncated…]' : text;
  const language = WORKER_LANGUAGES[lang] || WORKER_LANGUAGES.id;
  const basePrompt = lang === 'id'
    ? WORKER_CLAIM_EXTRACTION_PROMPT_ID
    : lang === 'en'
      ? WORKER_CLAIM_EXTRACTION_PROMPT_EN
      : genericClaimPrompt(language.name);
  const label = language.label;
  const prompt = basePrompt + `\n\n${label}:\n"""\n${truncated}\n"""`;
  const content = await workerCallLLM(prompt, env, 0.2, 2048);

  const claims = parseJSON(content);
  if (!Array.isArray(claims)) {
    throw new Error('Claim extractor returned a non-array response');
  }
  return claims
    .filter((claim) => typeof claim === 'string' && claim.trim().length >= 10)
    .map((claim) => claim.trim())
    .slice(0, 3);
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

const WORKER_NO_EVIDENCE = {
  id: 'Tidak ada bukti sumber yang ditemukan untuk mengevaluasi klaim ini.',
  en: 'No source evidence was found to evaluate this claim.',
  ja: 'この主張を評価するための出典情報が見つかりませんでした。',
  ko: '이 주장을 평가할 출처 근거를 찾지 못했습니다.',
  zh: '未找到可用于评估此声明的来源证据。',
  ar: 'لم يتم العثور على أدلة من مصادر لتقييم هذا الادعاء.',
  es: 'No se encontraron fuentes para evaluar esta afirmación.',
  pt: 'Nenhuma evidência de fonte foi encontrada para avaliar esta afirmação.',
  jv: 'Ora ana bukti sumber sing ditemokake kanggo mriksa klaim iki.',
  su: 'Teu aya bukti sumber anu kapanggih pikeun mariksa klaim ieu.',
};

async function workerGenerateVerdict(claim, evidence, env, lang = 'id') {
  if (evidence.length === 0) {
    return {
      verdict: 'Unverified',
      explanation: WORKER_NO_EVIDENCE[lang] || WORKER_NO_EVIDENCE.id,
      confidence: 'Low',
      key_sources: [],
    };
  }

  const evidenceText =
    evidence.length > 0
      ? evidence
          .map((e, i) => `[${i + 1}] ${e.title}\n    URL: ${e.url}\n    "${e.snippet}"`)
          .join('\n\n')
      : '(No evidence was found for this claim.)';

  const language = WORKER_LANGUAGES[lang] || WORKER_LANGUAGES.id;
  const basePrompt = lang === 'id'
    ? WORKER_VERDICT_PROMPT_ID
    : lang === 'en'
      ? WORKER_VERDICT_PROMPT_EN
      : genericVerdictPrompt(language.name) + '\n\nClaim:\n"{CLAIM}"\n\nEvidence:\n{EVIDENCE}';
  const prompt = basePrompt.replace('{CLAIM}', claim).replace('{EVIDENCE}', evidenceText);
  const content = await workerCallLLM(prompt, env, 0.1, 1024);

  const verdict = parseJSON(content);
  const validVerdicts = new Set(['True', 'False', 'Misleading', 'Unverified']);
  const validConfidence = new Set(['High', 'Medium', 'Low']);
  const evidenceUrls = new Set(
    evidence
      .map((item) => item.url)
      .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url)),
  );
  return {
    verdict: validVerdicts.has(verdict.verdict) ? verdict.verdict : 'Unverified',
    explanation: typeof verdict.explanation === 'string' && verdict.explanation.trim()
      ? verdict.explanation.trim()
      : (lang === 'en' ? 'No explanation provided.' : 'Tidak ada penjelasan yang diberikan.'),
    confidence: validConfidence.has(verdict.confidence) ? verdict.confidence : 'Low',
    key_sources: Array.isArray(verdict.key_sources)
      ? [...new Set(verdict.key_sources.filter((url) => evidenceUrls.has(url)))].slice(0, 3)
      : [],
  };
}

async function handleVerifyMobile(request, env, origin) {
  const payload = await readJson(request);
  const lang = Object.hasOwn(WORKER_LANGUAGES, payload.lang) ? payload.lang : 'id';
  if (payload.transcript && !payload.ocrText && !isCheckableTranscript(payload.transcript)) {
    return noClaimsResponse(origin);
  }
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

  if (!isCheckableTranscript(text)) {
    return noClaimsResponse(origin);
  }

  let claims;
  try {
    claims = await workerExtractClaims(text, env, lang);
  } catch (err) {
    console.log(JSON.stringify({ event: 'claim_extraction_failed', detail: err?.message || 'upstream' }));
    return json({ error: 'verification is unavailable' }, 502, origin);
  }
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
    let verdict;
    try {
      verdict = await workerGenerateVerdict(claim, evidence, env, lang);
    } catch (err) {
      console.log(JSON.stringify({ event: 'verdict_generation_failed', detail: err?.message || 'upstream' }));
      return json({ error: 'verification is unavailable' }, 502, origin);
    }
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

function noClaimsResponse(origin) {
  return json({
    verdict: 'Unverified',
    confidence: 'Low',
    explanation: 'No sufficiently clear factual statement was found in the transcript.',
    sources: [],
    claims: [],
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
      if (err.message === 'invalid json') {
        return json({ error: 'invalid json' }, 400, effectiveOrigin);
      }
      console.log(JSON.stringify({ event: 'unhandled', message: err.message }));
      return json({ error: 'proxy error' }, 500, effectiveOrigin);
    }
  },
};
