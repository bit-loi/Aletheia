/**
 * Runs the proxy Worker in plain Node.
 *
 * The handler is standard fetch(Request) -> Response and Node 20 ships those
 * globals, so no wrangler or workerd is needed to exercise the real logic.
 * Exercises the keyless paths only: no API keys are involved anywhere here.
 */
import worker from '../src/index.js';

const ORIGIN = 'chrome-extension://kocekjjgeahfmeolkkffcnbdjnpapdkb';

// No RL binding and no keys, exactly like a fresh Vercel deployment.
const env = {
  ALLOWED_ORIGINS: ORIGIN,
  LLM_CHAIN: 'gemini,groq',
  SEARCH_CHAIN: 'tavily,wikipedia',
};

const post = (path, body, origin = ORIGIN) =>
  new Request(`https://proxy.test${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let failures = 0;
async function check(name, req, expect) {
  const res = await worker.fetch(req, env);
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
  'rejects an empty query',
  post('/v1/search', {}),
  (r, b) => r.status === 400 && /query/.test(b.error || '')
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

await check(
  'unknown route 404s',
  post('/v1/nope', {}),
  (r, b) => r.status === 404
);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
