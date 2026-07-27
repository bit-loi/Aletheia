# SearXNG backend

Keyless, unquota'd search for Aletheia. First entry in the Worker's `SEARCH_CHAIN`.

## Why self-host

Public SearXNG instances block automated traffic — that is what their bot limiter is for, and hammering someone else's instance from a Worker is both unreliable and rude. Run your own.

## Run it

```bash
cd proxy/searxng
sed -i "s/CHANGE_ME_openssl_rand_hex_32/$(openssl rand -hex 32)/" settings.yml
docker compose up -d
```

Verify JSON output actually works before wiring anything up. **This is the step that catches the usual mistake:**

```bash
curl -s 'http://localhost:8080/search?q=test&format=json' | head -c 200
```

- JSON back → good.
- **HTTP 403** → `json` is missing from `search.formats` in `settings.yml`. This is the default state, and the failure is silent from the Worker's side.
- **HTML back** → the `format=json` parameter was dropped; check you edited the mounted config and restarted.

## Expose it to the Worker

The Worker runs on Cloudflare's network, so `localhost` is meaningless to it. Pick one:

- **Cloudflare Tunnel** (free, no inbound ports, same account as the Worker):
  ```bash
  cloudflared tunnel --url http://localhost:8080
  ```
  Use the printed `https://…trycloudflare.com` URL as `SEARXNG_URL`. Quick tunnels are ephemeral; for anything lasting, create a named tunnel.
- **Any small VPS** with a reverse proxy and TLS.

Then set it:

```jsonc
// proxy/wrangler.jsonc
"SEARXNG_URL": "https://your-tunnel-or-host"
```

and redeploy the Worker.

## Security note

`limiter: false` disables abuse protection. That is fine for an instance only your Worker can reach; it is not fine for a publicly-listed one. Keep it behind a tunnel or firewall, and do not add it to the public SearXNG instance list.

## Fallback behaviour

If SearXNG is down or unset, the Worker falls through to Tavily, then Wikipedia. If every backend fails it returns `{results: [], attempts:[…]}` with HTTP 200 — deliberately. An empty evidence set must reach the model as *no evidence*, so it returns Unverified rather than inventing support for a claim.
