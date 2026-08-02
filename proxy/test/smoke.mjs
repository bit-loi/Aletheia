/**
 * Runs the proxy Worker in plain Node.
 *
 * The handler is standard fetch(Request) -> Response and Node 20 ships those
 * globals, so no wrangler or workerd is needed to exercise the real logic.
 * Exercises the keyless paths only: no API keys are involved anywhere here.
 */
import worker from '../src/index.js';

const ORIGIN = 'chrome-extension://kocekjjgeahfmeolkkffcnbdjnpapdkb';
const MOBILE_TOKEN = 'server-only-mobile-token';

// No RL binding and no keys, exactly like a fresh Vercel deployment.
const env = {
  ALLOWED_ORIGINS: 'chrome-extension://*',
  LLM_CHAIN: 'gemini,openrouter,groq',
  SEARCH_CHAIN: 'tavily,wikipedia',
  MOBILE_API_TOKEN: MOBILE_TOKEN,
};

const post = (path, body, origin = ORIGIN) =>
  new Request(`https://proxy.test${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A mobile request: bearer token, and no Origin header at all. */
const postMobile = (path, body, token = MOBILE_TOKEN) =>
  new Request(`https://proxy.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

let failures = 0;
async function check(name, req, expect, testEnv = env) {
  const res = await worker.fetch(req, testEnv);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const ok = expect(res, parsed);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  [${res.status}]`);
  if (!ok) { failures++; console.log('       got:', JSON.stringify(parsed).slice(0, 220)); }
  return parsed;
}

console.log('--- keyless proxy behaviour ---\n');

await check('health is open', new Request('https://proxy.test/health'), (r) => r.status === 200);

await check(
  'rejects a foreign origin',
  post('/v1/search', { query: 'x' }, 'https://evil.example'),
  (r, b) => r.status === 403 && b.error === 'origin not allowed'
);

await check(
  'rejects a malformed extension origin',
  post('/v1/search', { query: 'x' }, 'chrome-extension://evil'),
  (r, b) => r.status === 403 && b.error === 'origin not allowed'
);

await check(
  'rejects an empty query',
  post('/v1/search', {}),
  (r, b) => r.status === 400 && /query/.test(b.error || '')
);

// --- mobile auth ---
// The mobile app sends no Origin at all. The bearer token is the only gate, so
// these four cases are what stand between the Gemini/Tavily keys and the world.

await check(
  'rejects a request with neither origin nor token',
  postMobile('/v1/search', { query: 'x' }, null),
  (r, b) => r.status === 403 && b.error === 'origin not allowed'
);

await check(
  'rejects a wrong bearer token',
  postMobile('/v1/search', { query: 'x' }, 'not-the-token'),
  (r, b) => r.status === 403 && b.error === 'origin not allowed'
);

await check(
  'verify-mobile is not reachable unauthenticated',
  postMobile('/v1/verify-mobile', { transcript: 'the sky is green' }, null),
  (r, b) => r.status === 403 && b.error === 'origin not allowed'
);

await check(
  'transcribe is not reachable unauthenticated',
  postMobile('/v1/transcribe', { audio: 'AAAA' }, null),
  (r, b) => r.status === 403 && b.error === 'origin not allowed'
);

await check(
  'a valid bearer token authorizes a request with no origin',
  postMobile('/v1/search', { query: 'Indonesia gross domestic product', max_results: 2 }),
  (r, b) => r.status === 200 && Array.isArray(b.results)
);

await check(
  'transcribe rejects a non-audio mime type',
  postMobile('/v1/transcribe', { audio: 'AAAA', mimeType: 'image/png' }),
  (r, b) => r.status === 400 && /unsupported audio type/.test(b.error || ''),
  { ...env, GEMINI_API_KEY: 'server-only-secret' }
);

await check(
  'a body past the text cap is a 413, not a 500',
  postMobile('/v1/chat', { messages: [{ role: 'user', content: 'x'.repeat(200 * 1024) }] }),
  (r, b) => r.status === 413 && b.error === 'payload too large'
);

const search = await check(
  'search falls through Tavily (no key) to Wikipedia',
  post('/v1/search', { query: 'Indonesia gross domestic product', max_results: 3 }),
  (r, b) => r.status === 200 && b.provider === 'wikipedia' && Array.isArray(b.results) && b.results.length > 0
);
if (search?.results?.length) {
  console.log('       first result:', search.results[0].title, '|', search.results[0].url);
  console.log('       snippet:', String(search.results[0].snippet).slice(0, 90) + '...');
}

await check(
  'chat reports unavailable rather than fabricating',
  post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] }),
  (r, b) => r.status === 503 && b.error === 'all providers unavailable'
);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions') {
    return new Response(null, { status: 400 });
  }
  if (String(input) === 'https://openrouter.ai/api/v1/chat/completions') {
    const authorized = init?.headers?.authorization === 'Bearer server-only-openrouter';
    const body = JSON.parse(init?.body || '{}');
    return authorized && body.model === 'google/gemma-4-26b-a4b-it:free'
      ? new Response(JSON.stringify({
          choices: [{ message: { content: '["OpenRouter fallback works."]' } }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(null, { status: 401 });
  }
  if (String(input).includes(':generateContent')) {
    const authorized = init?.headers?.['x-goog-api-key'] === 'server-only-secret';
    const body = JSON.parse(init?.body || '{}');
    const audioPart = body.contents?.[0]?.parts?.find((p) => p.inline_data);
    return authorized && audioPart?.inline_data?.mime_type === 'audio/wav'
      ? new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Jakarta is the capital.' }] } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(null, { status: 401 });
  }
  if (String(input) === 'https://generativelanguage.googleapis.com/v1beta/auth_tokens') {
    const authorized = init?.headers?.['x-goog-api-key'] === 'server-only-secret';
    return authorized
      ? new Response(JSON.stringify({ name: 'short-lived-gemini-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(null, { status: 401 });
  }
  return realFetch(input, init);
};
await check(
  'chat falls through Gemini to the pinned OpenRouter free model',
  post('/v1/chat', { messages: [{ role: 'user', content: 'extract a claim' }] }),
  (r, b) => r.status === 200 &&
    b.provider === 'openrouter' &&
    b.content === '["OpenRouter fallback works."]' &&
    !JSON.stringify(b).includes('server-only-openrouter'),
  {
    ...env,
    LLM_CHAIN: 'gemini,openrouter',
    GEMINI_API_KEY: 'configured-but-rejected',
    OPENROUTER_API_KEY: 'server-only-openrouter',
    OPENROUTER_MODEL: 'google/gemma-4-26b-a4b-it:free',
  }
);
await check(
  'transcribe sends audio to Gemini natively and keeps the key server-side',
  postMobile('/v1/transcribe', { audio: 'UklGRiQAAABXQVZF', mimeType: 'audio/wav' }),
  (r, b) => r.status === 200 &&
    b.transcript === 'Jakarta is the capital.' &&
    b.inaudible === false &&
    !JSON.stringify(b).includes('server-only-secret'),
  { ...env, GEMINI_API_KEY: 'server-only-secret', GEMINI_TRANSCRIBE_MODEL: 'gemini-2.5-flash' }
);
await check(
  'Gemini server secret exchanges for a short-lived Live token',
  post('/v1/gemini-live-token', {}),
  (r, b) => r.status === 200 &&
    b.token === 'short-lived-gemini-token' &&
    !JSON.stringify(b).includes('server-only-secret'),
  { ...env, GEMINI_API_KEY: 'server-only-secret' }
);
globalThis.fetch = realFetch;

await check(
  'unknown route 404s',
  post('/v1/nope', {}),
  (r, b) => r.status === 404
);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
