/**
 * A built PWA served the way Cloudflare Pages serves it: `wrangler pages dev` over the `dist`
 * directory, so `_headers` (including `!` detachment), `_redirects` and the pretty-URL 308s that
 * strip `.html` all apply exactly as they do in production.
 *
 * WHY NOT `startReleaseOrigin` (`pwa-release.ts`): that origin hands every file the `/*` policy and
 * no redirect at all, which is the right simplification for a release journey and exactly the gap
 * that let the `fy-render` shells ship unframeable — `/fy-render-sandbox.html` redirects to
 * `/fy-render-sandbox` in production, and only a Pages runtime knows to do that.
 *
 * Wrangler is pinned by the flake (`nix/env.nix`), runs entirely on loopback and needs no Cloudflare
 * credentials. Its compatibility date is fixed, because the bundled runtime refuses a date newer than
 * itself and a static site uses no runtime feature a date could change.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessTeardown } from './relay-harness.ts';

const COMPATIBILITY_DATE = '2025-01-01';

export interface PagesOrigin {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
}

/**
 * A loopback port nothing is listening on right now. Not one of the fixture's leased ports: a lease
 * keeps its port bound, and wrangler's runtime fails to start on an address already in use.
 */
const freePort = (): number => {
  const probe = Bun.serve({ fetch: () => new Response(''), hostname: '127.0.0.1', port: 0 });
  const port = probe.port as number;
  probe.stop(true);
  return port;
};

/** Serves `dist` under Pages semantics on a free loopback port, and stops it on teardown. */
export async function startPagesDev(dist: string, scratch: string, teardown: HarnessTeardown): Promise<PagesOrigin> {
  await mkdir(scratch, { recursive: true });
  const port = freePort();
  const inspector = freePort();
  const output: string[] = [];
  const child = spawn(
    'wrangler',
    [
      'pages',
      'dev',
      dist,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      `--compatibility-date=${COMPATIBILITY_DATE}`,
      '--inspector-port',
      String(inspector),
      '--persist-to',
      join(scratch, 'state'),
    ],
    {
      cwd: scratch,
      // Wrangler's config, logs and metrics consent live under these; none of them may be the machine's.
      env: {
        ...process.env,
        CI: '1',
        HOME: scratch,
        WRANGLER_SEND_METRICS: 'false',
        XDG_CONFIG_HOME: join(scratch, 'config'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', chunk => output.push(String(chunk)));
  child.stderr?.on('data', chunk => output.push(String(chunk)));
  teardown.add('wrangler pages dev', async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), Bun.sleep(5_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  const origin = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/app/`, { redirect: 'manual' });
      if (response.status < 500) return { origin };
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`wrangler pages dev did not serve ${dist} on ${origin}:\n${output.join('').slice(-4_000)}`);
}
