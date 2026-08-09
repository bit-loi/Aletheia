# Aletheia proxy

Holds the API keys server-side so the extension works on install with nothing to configure.

## Why this exists

A key bundled into a browser extension is a **published** key. The package is a zip; any user can read it out of their own profile directory or unpack the `.crx`. Ship a key and the quota becomes everyone's, and if billing is attached, you pay for it.

So the extension ships with no keys. It calls this Worker, which holds them.

The popup is a one-click launch panel, not a credential form. Article requests
use Gemini and Tavily through the proxy. YouTube tab audio streams directly to
Gemini Live with a short-lived token.

## Where to deploy

The logic is standard `fetch(Request) -> Response`, so it runs unmodified on any
edge runtime. Two entry points are provided:

| Platform | Entry point | Notes |
|---|---|---|
| Deno Deploy | `deno.js` | Lowest friction: no npm, no CLI, deploys from GitHub. Verified locally. |
| Cloudflare Workers | `src/index.js` | Native. Only option with the rate-limit binding. |
| Vercel Edge | `api/index.js` | Thin adapter. Deployable from GitHub with no local tooling. |

### Deno Deploy

1. Push this repo to GitHub.
2. dash.deno.com → New Project → link the repo.
3. Entry point: `proxy/deno.js`
4. Add environment variables (see the table below), then deploy.

To run it locally first:

```bash
cd proxy
ALLOWED_ORIGINS='chrome-extension://<your-extension-id>' \
SEARCH_CHAIN='tavily,wikipedia' LLM_CHAIN='gemini,openrouter,groq' \
  deno run --allow-net --allow-env deno.js
curl localhost:8000/health
```

### Environment variables

| Name | Example | Secret |
|---|---|---|
| `GEMINI_API_KEY` | | yes |
| `OPENROUTER_API_KEY` | | yes |
| `TAVILY_API_KEY` | | yes |
| `ALLOWED_ORIGINS` | `chrome-extension://*` | no |
| `LLM_CHAIN` | `gemini,openrouter,groq` | no |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | no |
| `GEMINI_TRANSCRIBE_MODEL` | `gemini-2.5-flash` | no |
| `TRANSCRIBE_CHAIN` | `gemini,workers_ai` | no |
| `WORKERS_AI_TRANSCRIBE_MODEL` | `@cf/openai/whisper-large-v3-turbo` | no |
| `OPENROUTER_MODEL` | `google/gemma-4-26b-a4b-it:free` | no |
| `SEARCH_CHAIN` | `tavily,wikipedia` | no |

**No rate limiting outside Cloudflare.** The limiter is a Workers binding. On
Vercel `env.RL` is undefined, the code degrades and logs `rate_limiter_missing`,
and the proxy is unprotected. Fine for a demo behind an unlisted URL; add
Vercel's WAF/rate limiting or Upstash before publicising it.

### Vercel, without installing anything

1. Push this repo to GitHub.
2. vercel.com → Add New → Project → import the repo.
3. Set **Root Directory** to `proxy`.
4. Settings → Environment Variables:
   - `GEMINI_API_KEY`, `TAVILY_API_KEY` (mark as secret)
   - `ALLOWED_ORIGINS`, `LLM_CHAIN=gemini,openrouter,groq`, `GEMINI_MODEL`, `OPENROUTER_MODEL`, `SEARCH_CHAIN=tavily,wikipedia`
5. Deploy. The URL it prints goes into `../config.js` and `../manifest.json`.

No npm, no CLI, no login flow in a terminal.

## Deploy on Cloudflare

```bash
cd proxy
npm install -g wrangler        # or npx wrangler
wrangler login

# Secrets - never put these in wrangler.jsonc
wrangler secret put GEMINI_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put GROQ_API_KEY          # optional, third in the chain
wrangler secret put TAVILY_API_KEY

wrangler deploy
```

Then set two things:

1. `ALLOWED_ORIGINS` in `wrangler.jsonc`. Use `chrome-extension://*` when
   distributing unpacked builds, because Chrome derives a different id from
   each install path. A published extension can instead use its one exact id.
2. `PROXY_URL` in `../config.js` and the matching entry in `../manifest.json` `host_permissions` to your deployed Worker URL.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/v1/chat` | `{messages, temperature?, max_tokens?}` | `{content, provider}` |
| `POST` | `/v1/search` | `{query, max_results?}` | `{results: [{title, url, snippet}]}` |
| `POST` | `/v1/transcribe` | `{audio, mimeType}` | `{transcript, inaudible, provider, model}` |
| `POST` | `/v1/verify-mobile` | `{transcript, lang}` | `{claims, verdict, confidence, explanation, sources}` |
| `POST` | `/v1/gemini-live-token` | | `{token}` |
| `GET` | `/health` | | `ok` |

## Provider chains

**`LLM_CHAIN`** lists model providers in preference order. Every entry speaks the OpenAI `/chat/completions` shape, so failover costs only a base URL and a model id. Configured: `gemini` (via Google's OpenAI-compatibility layer), `openrouter`, `groq`, `nvidia`, `pollinations`.

**`TRANSCRIBE_CHAIN`** is separate because audio providers do not share the
chat-completions request shape. Gemini native audio is primary. Retryable
Gemini throttling and server failures get one bounded retry with jitter, then
Cloudflare Workers AI runs the configured Whisper model through the `AI`
binding. Deployments outside Cloudflare simply skip that unavailable binding.

The default OpenRouter fallback is pinned to
`google/gemma-4-26b-a4b-it:free`. Pinning avoids the output-quality variance of
the random `openrouter/free` router, while `OPENROUTER_MODEL` keeps the free
model replaceable when OpenRouter's catalog changes. Free-model rate limits and
availability are not production guarantees.

**`SEARCH_CHAIN`** does the same for evidence retrieval: `searxng` (self-hosted, keyless, unquota'd — see [searxng/README.md](searxng/README.md)), then `tavily` (1,000 credits/month free), then `wikipedia` (keyless, no quota, strong on historical and scientific claims, useless on breaking news).

If every search backend fails, the proxy returns `{results: [], attempts}` with HTTP 200 rather than an error. That is deliberate: an empty evidence set must reach the model as *no evidence*, so it returns Unverified instead of inventing support.

This is what makes the extension's fabricated-claims fallback unnecessary. When one free tier is busy another answers, and if all of them fail the proxy returns `503` so the pipeline can report a real error instead of inventing a claim to keep the UI looking alive.

## Abuse controls, and their honest limits

- **Per-IP rate limit**, 30 requests/minute. Cloudflare rate limits are per-location and eventually consistent, so this is a blunt brake, not accounting.
- **Origin allow-list.** The unpacked distribution accepts any syntactically
  valid Chrome extension origin. `Origin` is trivially forged by non-browser
  clients, so this is routing friction, **not authentication**. The rate limit
  is what actually bounds cost.

If this ever needs to be real, issue a per-install token at first run and verify it here.

## Cost

Workers free tier is 100,000 requests/day with no card. One fact-check is roughly 1 + N requests for N claims, so the binding constraint will be the upstream LLM free tiers, not Workers.
