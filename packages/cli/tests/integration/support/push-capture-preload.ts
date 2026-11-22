/**
 * Bun `--preload` for a real daemon in a test (see `bootRealDaemon`'s `preload` option): the push seam at the process
 * boundary. A daemon cannot reach a loopback host (a plugin's network is its manifest's exact hosts), and a SIT must not
 * reach a real push service, so a request to a push service host is answered 201 here and ONE line is appended to
 * `$FY_HOME/pushes.log` (the host only, never a body or a key). Every other request goes through untouched.
 */
import { appendFileSync } from 'node:fs';

const real = globalThis.fetch;
const home = process.env.FY_HOME ?? '';

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.hostname.endsWith('.googleapis.com')) return await real(input, init);
    appendFileSync(`${home}/pushes.log`, `${url.hostname}\n`);
    return new Response(null, { status: 201 });
  },
  { preconnect: real.preconnect },
) as typeof fetch;
