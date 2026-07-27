# Aletheia proxy

Holds the API keys server-side so the extension works on install with nothing to configure.

## Why this exists

A key bundled into a browser extension is a **published** key. The package is a zip; any user can read it out of their own profile directory or unpack the `.crx`. Ship a key and the quota becomes everyone's, and if billing is attached, you pay for it.

So the extension ships with no keys. It calls this Worker, which holds them.

Users can still enter their own keys in the extension popup. That path bypasses the proxy entirely and keeps their traffic off the shared quota.

## Where to deploy

The logic is standard `fetch(Request) -> Response`, so it runs unmodified on any
edge runtime. Two entry points are provided:

| Platform | Entry point | Notes |
|---|---|---|
| Cloudflare Workers | `src/index.js` | Native. Only option with the rate-limit binding. |
| Vercel Edge | `api/index.js` | Thin adapter. Deployable from GitHub with **no local tooling**. |

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
   - `ALLOWED_ORIGINS`, `LLM_CHAIN=gemini,groq`, `GEMINI_MODEL`, `SEARCH_CHAIN=tavily,wikipedia`
5. Deploy. The URL it prints goes into `../config.js` and `../manifest.json`.

No npm, no CLI, no login flow in a terminal.

## Deploy on Cloudflare

```bash
cd proxy
npm install -g wrangler        # or npx wrangler
wrangler login

# Secrets - never put these in wrangler.jsonc
wrangler secret put NVIDIA_API_KEY
wrangler secret put GROQ_API_KEY          # optional, second in the chain
wrangler secret put TAVILY_API_KEY

wrangler deploy
```

Then set two things:

1. `ALLOWED_ORIGINS` in `wrangler.jsonc` to your extension's id (`chrome-extension://<id>`). For an unpacked build the id is derived from the load path and is stable as long as the directory does not move.
2. `PROXY_URL` in `../config.js` and the matching entry in `../manifest.json` `host_permissions` to your deployed Worker URL.

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/v1/chat` | `{messages, temperature?, max_tokens?}` | `{content, provider}` |
| `POST` | `/v1/search` | `{query, max_results?}` | `{results: [{title, url, snippet}]}` |
| `GET` | `/health` | | `ok` |

## Provider chains

**`LLM_CHAIN`** lists model providers in preference order. Every entry speaks the OpenAI `/chat/completions` shape, so failover costs only a base URL and a model id. Configured: `gemini` (via Google's OpenAI-compatibility layer), `groq`, `nvidia`, `pollinations`.

**`SEARCH_CHAIN`** does the same for evidence retrieval: `searxng` (self-hosted, keyless, unquota'd — see [searxng/README.md](searxng/README.md)), then `tavily` (1,000 credits/month free), then `wikipedia` (keyless, no quota, strong on historical and scientific claims, useless on breaking news).

If every search backend fails, the proxy returns `{results: [], attempts}` with HTTP 200 rather than an error. That is deliberate: an empty evidence set must reach the model as *no evidence*, so it returns Unverified instead of inventing support.

This is what makes the extension's fabricated-claims fallback unnecessary. When one free tier is busy another answers, and if all of them fail the proxy returns `503` so the pipeline can report a real error instead of inventing a claim to keep the UI looking alive.

## Abuse controls, and their honest limits

- **Per-IP rate limit**, 30 requests/minute. Cloudflare rate limits are per-location and eventually consistent, so this is a blunt brake, not accounting.
- **Origin allow-list.** `Origin` is set by browsers but trivially forged by any non-browser client. This is friction against casual abuse, **not authentication**. The rate limit is what actually bounds cost.

If this ever needs to be real, issue a per-install token at first run and verify it here.

## Cost

Workers free tier is 100,000 requests/day with no card. One fact-check is roughly 1 + N requests for N claims, so the binding constraint will be the upstream LLM free tiers, not Workers.
