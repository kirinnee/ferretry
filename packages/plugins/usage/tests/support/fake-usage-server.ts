/**
 * THE PROVIDERS' FREE USAGE READS, ANSWERED ON THIS MACHINE.
 *
 * The usage pass makes one `GET` per idle login — Anthropic's `/api/oauth/usage`, ChatGPT's
 * `/backend-api/wham/usage` — with that login's bearer token. A fixture whose logins are real stores
 * must never send those anywhere, so the daemon is started with `FY_USAGE_PROBE_ORIGIN` pointing here
 * and these answer every read with a fixed, plausible reading.
 *
 * It counts reads by path, so a test can prove the pass it measured really ran, and it records nothing
 * else: no header, no token, no body of a request is kept or printed.
 */

/** The two endpoints, by the path the probes send them to. */
export const ANTHROPIC_USAGE_PATH = '/api/oauth/usage';
export const CODEX_USAGE_PATH = '/backend-api/wham/usage';

export interface FakeUsageServer {
  /** `http://127.0.0.1:<port>`: the value for `FY_USAGE_PROBE_ORIGIN`. */
  readonly origin: string;
  /** Reads answered so far, by path. Any other path is answered 404 and counted too. */
  readonly hits: ReadonlyMap<string, number>;
  stop(): Promise<void>;
}

/** Anthropic's usage document: utilization as a percentage, and when each window resets. */
const anthropicBody = (now: number) => ({
  five_hour: { utilization: 12, resets_at: new Date(now + 3 * 3_600_000).toISOString() },
  seven_day: { utilization: 40, resets_at: new Date(now + 4 * 86_400_000).toISOString() },
});

/** ChatGPT's usage document for a Codex login. */
const codexBody = () => ({
  rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 9, reset_after_seconds: 7_200 },
    secondary_window: { used_percent: 31, reset_after_seconds: 300_000 },
  },
});

/** Starts the server on a free loopback port. */
export function startFakeUsageServer(now: () => number = Date.now): FakeUsageServer {
  const hits = new Map<string, number>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
      if (request.method === 'GET' && pathname === ANTHROPIC_USAGE_PATH) return Response.json(anthropicBody(now()));
      if (request.method === 'GET' && pathname === CODEX_USAGE_PATH) return Response.json(codexBody());
      return new Response('not found', { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    hits,
    stop: async () => {
      await server.stop(true);
    },
  };
}
