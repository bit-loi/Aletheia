/**
 * Vercel Edge Function entry point.
 *
 * The proxy logic in ../src/index.js is written against the Web standard
 * `fetch(Request) -> Response` signature, which is exactly what Vercel's Edge
 * runtime expects, so this is a thin adapter rather than a port.
 *
 * Two differences from Cloudflare, both already handled upstream:
 *
 *   - Bindings do not exist here. Config and secrets arrive on process.env
 *     instead of an `env` argument, so we pass process.env straight through.
 *   - There is no rate-limit binding, so `env.RL` is undefined. src/index.js
 *     already treats the limiter as optional and logs when it is absent, so
 *     requests are served rather than failing.
 *
 * That second point matters: WITHOUT the binding this deployment has no rate
 * limiting. Do not publicise the URL. See README for options.
 */
import worker from '../src/index.js';

export const config = { runtime: 'edge' };

export default function handler(request) {
  return worker.fetch(request, process.env);
}
