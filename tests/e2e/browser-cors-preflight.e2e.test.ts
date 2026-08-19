/**
 * REAL CHROME, REAL COMPILED DAEMON: can a page at another origin make the request at all?
 *
 * This is the tier that would have caught the shipped defect, and the only one that could. The
 * browser's own tests send their headers to a fixture that answers whatever it is asked; the daemon's
 * integration tests exercise the transport with the headers the transport already knows; both were
 * green for the whole time the hosted PWA could not apply a fleet proposal or change a grant, because
 * `x-ferretry-operator-unlock` was absent from `CORS_REQUEST_HEADERS` and Chrome therefore never sent
 * the POST at all.
 *
 * So the claim here is deliberately narrow and deliberately not about authorization:
 *
 *   the request LEAVES the browser and the daemon answers it.
 *
 * A 401 is a pass. What is being proved is reachability — that the preflight admitted the header the
 * PWA really sends, that the POST followed it, and that the daemon's answer was readable to the page.
 * Whether that answer is 200 or 401 is the authorization question, which every other tier already
 * covers and this one must not be confused with.
 *
 * ── WHY THE PAGE IS ON LOOPBACK ────────────────────────────────────────────────────────────────
 *
 * The page is served from a second loopback port rather than a public HTTPS origin, which makes it
 * cross-origin to the daemon — the only property this journey needs — without depending on the
 * network or on DNS. Chrome gates a PUBLIC page's request to a loopback address behind the Local
 * Network Access permission, measured and handled once in `launchChrome`; local-to-local is not
 * gated. So this proves the CORS contract, and it deliberately does not claim to prove the hosted
 * origin's address-space permission, which is the browser's decision and not the daemon's.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────────────────────────────
 *
 *     task compile && task test:e2e
 *     # or just this file:
 *     CLI_BIN=dist/bin/fy-linux-x64-baseline FY_E2E_REAL_TMUX="$(command -v tmux)" \
 *       bun test tests/e2e/browser-cors-preflight.e2e.test.ts --config=bunfig.e2e.toml --timeout 180000
 *
 * This tier does not run in CI. The header agreement it depends on is held there instead by
 * `scripts/validate/cors-header-agreement.sh` and by the daemon's own integration case at a real
 * socket; this file is the evidence that a real browser agrees with both.
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { withE2eEnvironment } from './fixture.ts';
import { harnessTeardown, type HarnessTeardown, launchChrome } from './support/relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');

/** The header the PWA sends on every governed mutation the operator password authorizes. */
const UNLOCK_HEADER = 'x-ferretry-operator-unlock';
/**
 * A name the admitted one is a prefix of.
 *
 * It is here because a wildcard, a prefix test or a `startsWith` would pass the case above and admit
 * this too, and the whole value of the allowlist is that it does not.
 */
const LOOKALIKE_HEADER = `${UNLOCK_HEADER}-secret`;

/** The compiled daemon, named the way `scripts/release/compile.sh` names it. */
function compiledDaemon(): string {
  const explicit = process.env.FYD_BIN;
  if (explicit !== undefined && explicit !== '') return resolve(REPOSITORY_ROOT, explicit);
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${platform}-${architecture}`);
}

/**
 * The page the browser runs the requests from: one document, at its own loopback origin.
 *
 * Not the built PWA bundle. The subject is what the TRANSPORT does with a cross-origin request, and
 * routing this through the app's own connection state would make a red run ambiguous between the two.
 */
async function startPage(teardown: HarnessTeardown): Promise<{ readonly origin: string }> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('<!doctype html><title>cors probe</title><p>cors probe', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  });
  teardown.add('cors probe page', async () => {
    await server.stop(true);
  });
  return { origin: `http://127.0.0.1:${server.port}` };
}

/**
 * The daemon's configuration, written OUTSIDE the state home and read with `--config`.
 *
 * A `config/daemon.json` placed into an empty `FY_HOME` makes that home non-empty with no
 * layout-version marker, and the daemon refuses to open it and says to run `fy daemon adopt`.
 *
 * `relay.enabled: false` because a default install reads a hosted advertisement at boot, and a
 * journey about CORS must not reach a real service to find out. The block still needs a `url` — the
 * schema keeps a switched-off address readable rather than deleted — so it carries one nothing can
 * dial rather than a real rendezvous.
 */
function daemonDocument(input: { readonly bindPort: number; readonly appOrigin: string }): string {
  return `${JSON.stringify(
    {
      corsOrigins: [input.appOrigin],
      carriers: [{ kind: 'bind', host: '127.0.0.1', port: input.bindPort }],
      relay: { url: 'ws://127.0.0.1:1', enabled: false },
    },
    null,
    2,
  )}\n`;
}

interface Attempt {
  /** Whether `fetch` RESOLVED — the request left the browser and an answer came back. */
  readonly resolved: boolean;
  readonly status: number | null;
  readonly error: string | null;
}

/**
 * One cross-origin POST from the page, reported as what JavaScript could observe.
 *
 * A blocked request and a refused one are the same `TypeError` with no status, which is exactly why
 * the owner's report of this defect read as "Failed to fetch": the distinction lives in `resolved`.
 */
function attemptScript(applyUrl: string, header: string): string {
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(applyUrl)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ${JSON.stringify(header)}: 'operator-password' },
        body: '{}',
      });
      return { resolved: true, status: response.status, error: null };
    } catch (error) {
      return { resolved: false, status: null, error: String(error) };
    }
  })()`;
}

describe('a real browser at another origin, and a compiled daemon', () => {
  it('should let a cross-origin page send the operator unlock header and refuse a lookalike', async () => {
    // Arrange
    const teardown = harnessTeardown();
    try {
      await withE2eEnvironment(async environment => {
        const page = await startPage(teardown);
        const configPath = join(environment.paths.root, 'daemon.json');
        await writeFile(
          configPath,
          daemonDocument({ bindPort: environment.ports.api, appOrigin: page.origin }),
          'utf8',
        );
        await environment.startDaemon({
          command: [compiledDaemon(), '--config', configPath],
          readyUrl: environment.httpUrl('/v1/health'),
          timeoutMs: 30_000,
        });
        const applyUrl = environment.httpUrl('/v1/fleet/proposals/fy_fprop_probe/apply');
        const browser = await launchChrome(teardown);
        await browser.page.goto(page.origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // Act
        const admitted = await browser.page.evaluate<Attempt>(attemptScript(applyUrl, UNLOCK_HEADER));
        const lookalike = await browser.page.evaluate<Attempt>(attemptScript(applyUrl, LOOKALIKE_HEADER));

        // Assert
        // The daemon answered the browser: which status it chose is the authorization question, and
        // any answer at all is the reachability claim this journey exists for.
        should(admitted.resolved).be.true();
        should(admitted.status).be.a.Number();
        should(admitted.error).be.null();
        // And the enumeration is still an enumeration: a name the admitted one is a prefix of never
        // leaves the browser, which is the same failure the owner saw before the entry was added.
        should(lookalike.resolved).be.false();
        should(lookalike.status).be.null();
        should(lookalike.error).match(/Failed to fetch/u);
      });
    } finally {
      await teardown.closeAll();
    }
  });
});
