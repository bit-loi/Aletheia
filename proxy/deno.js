/**
 * Deno Deploy entry point.
 *
 * src/index.js is written against the Web standard fetch(Request) -> Response
 * signature, which is Deno's native server interface, so this is an adapter
 * rather than a port. It also has zero imports, so there is nothing for Deno
 * to resolve from npm.
 *
 * Differences from Cloudflare, both already handled upstream:
 *
 *   - No bindings. Config and secrets come from Deno.env rather than an `env`
 *     argument, so the whole environment is passed straight through.
 *   - No rate-limit binding, so `env.RL` is undefined. src/index.js treats the
 *     limiter as optional and logs `rate_limiter_missing`, so requests are
 *     served rather than erroring.
 *
 * That second point is the tradeoff: this deployment has NO rate limiting.
 * Keep the URL unlisted, or put Deno Deploy behind something that does.
 */
import worker from './src/index.js';

Deno.serve((request) => worker.fetch(request, Deno.env.toObject()));
