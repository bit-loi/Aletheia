/**
 * Aletheia proxy.
 *
 * Holds the API keys server-side so the extension ships with none. A key
 * bundled into an extension is a published key: the package is a zip, anyone
 * can read it out of their own profile directory, and the quota is then
 * everyone's. This Worker exists so users can install and go.
 *
 * Endpoints
 *   POST /v1/chat            OpenAI-shaped chat completion
 *   POST /v1/search          evidence search
 *   POST /v1/gemini-live-token short-lived browser credential for live audio
 *   GET  /health             liveness
 *
 * Bindings (see wrangler.jsonc)
 *   env.RL               rate limiter
 *   env.ALLOWED_ORIGINS  comma-separated chrome-extension:// origins; supports
 *                        chrome-extension://* for unpacked installs
 *   env.LLM_CHAIN        comma-separated provider ids, in preference order
 *   env.GEMINI_API_KEY / env.OPENROUTER_API_KEY / env.GROQ_API_KEY /
 *   env.TAVILY_API_KEY  (secrets)
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
const UPSTREAM_TIMEOUT_MS = 25000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
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

/** Read a JSON body with a hard size cap. */
async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new Error('payload too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('payload too large');
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: corsHeaders('*') });
    }

    const origin = allowedOrigin(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: origin ? 204 : 403, headers: corsHeaders(origin || '') });
    }
    if (!origin) {
      return json({ error: 'origin not allowed' }, 403, null);
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, origin);
    }

    // The rate-limit binding is configured in wrangler.jsonc. If this Worker was
    // created through the dashboard instead, the binding may be absent; degrade
    // rather than throwing, and say so in the logs so it is not silently
    // unprotected.
    if (env.RL && typeof env.RL.limit === 'function') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RL.limit({ key: ip });
      if (!success) {
        return json({ error: 'rate limited', retryAfter: 60 }, 429, origin);
      }
    } else {
      console.log(JSON.stringify({ event: 'rate_limiter_missing' }));
    }

    try {
      if (url.pathname === '/v1/chat') return await handleChat(request, env, origin);
      if (url.pathname === '/v1/search') return await handleSearch(request, env, origin);
      if (url.pathname === '/v1/gemini-live-token') return await handleGeminiLiveToken(env, origin);
      return json({ error: 'not found' }, 404, origin);
    } catch (err) {
      // Explicit handling rather than passThroughOnException, which would hide
      // the bug and return an opaque 1101.
      console.log(JSON.stringify({ event: 'unhandled', message: err.message }));
      return json({ error: 'proxy error' }, 500, origin);
    }
  },
};
