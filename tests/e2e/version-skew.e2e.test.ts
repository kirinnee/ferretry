import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { pairingLinkUrl } from '../../packages/protocol/src/lib/pairing.ts';
import { OLDER_APP_SENTENCE, OLDER_DAEMON_SENTENCE } from '../../packages/protocol/src/lib/relay-session.ts';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';
import {
  launchReleaseBrowser,
  type ReleasePage,
  release,
  screenshotWidths,
  startReleaseOrigin,
  throwawayKey,
  viteBuild,
} from './support/pwa-release';
import { type HarnessTeardown, harnessTeardown } from './support/relay-harness';
import { retryOnLostBrowser } from './support/product-harness';

/**
 * Version skew between the app and a daemon, from the side a person sees.
 *
 * THERE IS NO NUMERIC NEGOTIATION. What each side knows about the other's age is the session dialect:
 * a daemon names its own in `/healthz` (`sessionProtocol`), the app reads that after its direct
 * socket fails (`daemonIsOutdated`, `packages/pwa/src/lib/relay-carrier.ts`), and the daemon refuses
 * an app from before device keys with HTTP 426 and `OLDER_APP_SENTENCE`
 * (`packages/daemon/src/lib/api/dispatcher.ts`). Every journey below therefore builds its "other
 * version" at exactly that seam:
 *
 * - NEW APP, OLD DAEMON: a stand-in that answers `/healthz` as a `ferretry-relay/1` daemon did and,
 *   like it, refuses this app's session path. The app is the real current build in a real Chrome.
 * - NEW APP, NEWER DAEMON: the same stand-in one dialect AHEAD — the app every person has open the
 *   day a daemon release moves the dialect on.
 * - OLD APP, NEW DAEMON: the REAL compiled daemon, sent exactly the credential an app from before
 *   device keys holds. Building that app from an old tag would need a full install of an old
 *   workspace; what it would receive is decided entirely by the daemon, so that is what is asserted.
 *
 * The app is served unsigned on loopback — the release worker calls that "unverified" and stays out
 * of the way, so nothing here is about signing.
 */

/** Screenshots land under `$FY_E2E_SHOTS_ROOT/version-skew` (default: the system temp directory). */
const SHOTS = join(process.env.FY_E2E_SHOTS_ROOT ?? join(tmpdir(), 'fy-e2e-shots'), 'version-skew');
/** Never a real service: relay discovery is compiled to a closed loopback port. */
const DEAD_DIRECTORY = 'http://127.0.0.1:9';
const REPOSITORY_ROOT = join(import.meta.dir, '..', '..');
const STAGE = '[data-pairing-stage]';
const CONFIRM = '[data-pair-confirm]';
/** A well-formed code and identity: the stand-ins never get far enough to check either. */
const CODE = 'ABCD-EFGH';
const DAEMON_ID = `fy_daemon_${'A'.repeat(43)}`;

interface StandInDaemon {
  readonly url: string;
  requests(): readonly string[];
}

/**
 * A daemon of another session dialect, as much of one as the app can observe: its public liveness
 * route, and a refusal of everything else exactly as an unknown route is refused.
 */
function startDialectStandIn(teardown: HarnessTeardown, sessionProtocol: string, appOrigin: string): StandInDaemon {
  const requests: string[] = [];
  const cors = {
    'access-control-allow-origin': appOrigin,
    'access-control-allow-headers': 'authorization, content-type, x-fy-version',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'x-ferretry-version': sessionProtocol.endsWith('/1') ? '1.0.0' : '99.0.0',
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (path === '/healthz')
        return Response.json(
          { status: 'ok', version: cors['x-ferretry-version'], sessionProtocol, uptimeSeconds: 42 },
          { headers: cors },
        );
      return Response.json(
        { error: 'no such route', code: 'unknown_route', method: request.method, path },
        { status: 404, headers: cors },
      );
    },
  });
  teardown.add(`${sessionProtocol} stand-in`, async () => {
    await server.stop(true);
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, requests: () => [...requests] };
}

/** The app, built once for this file and served unsigned on its own loopback origin. */
async function serveApp(environment: E2eEnvironment, teardown: HarnessTeardown): Promise<string> {
  const root = environment.paths.root;
  const build = await viteBuild(join(root, 'vite'), DEAD_DIRECTORY);
  const key = await throwawayKey(join(root, 'keys'), 'unused');
  const unsigned = await release({ build, into: join(root, 'app'), key, sequence: 1, commit: 'fffffff', sign: false });
  const origin = await startReleaseOrigin(teardown);
  origin.serve(unsigned);
  return origin.loopbackOrigin;
}

/** Opens a pairing link to `daemonUrl`, confirms it, and returns what the failed stage says. */
async function pairAndReadFailure(page: ReleasePage, appOrigin: string, daemonUrl: string): Promise<string> {
  const link = pairingLinkUrl(`${appOrigin}/pair`, { daemonUrl, code: CODE, daemonId: DAEMON_ID });
  // A fresh document every time: a link that differs only in its fragment would otherwise be a
  // same-document navigation onto the screen the previous attempt left.
  await page.goto('about:blank');
  await page.goto(link, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector(CONFIRM, { timeout: 30_000 }).catch(async (error: unknown) => {
    const text = await page.evaluate<string>('document.body.innerText').catch(() => '');
    throw new Error(`the pairing screen offered no confirm control; it showed:\n${text}`, { cause: error });
  });
  await page.evaluate(`document.querySelector('${CONFIRM}').click()`);
  await page.waitForSelector('[data-pairing-stage="failed"], [role="alert"]', { timeout: 60_000 });
  await Bun.sleep(500);
  return await page.evaluate<string>(`document.querySelector('${STAGE}')?.innerText ?? document.body.innerText`);
}

/** The failed pairing in light and then dark, each shot at 390px and 1280px. */
async function pairInEachScheme(
  page: ReleasePage,
  appOrigin: string,
  daemonUrl: string,
  name: string,
): Promise<readonly string[]> {
  const shown: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    shown.push(await pairAndReadFailure(page, appOrigin, daemonUrl));
    await screenshotWidths(page, SHOTS, name, scheme);
  }
  return shown;
}

/** How many of the two sentences a screen says — a skew notice names ONE side. */
function sentencesShown(text: string): { readonly olderDaemon: boolean; readonly olderApp: boolean } {
  const flat = text.replace(/\s+/gu, ' ');
  return { olderDaemon: flat.includes(OLDER_DAEMON_SENTENCE), olderApp: flat.includes(OLDER_APP_SENTENCE) };
}

describe('version skew between the app and a daemon', () => {
  it('should tell a new app paired to an OLD daemon to update the daemon', () =>
    retryOnLostBrowser('version-skew', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange
          const appOrigin = await serveApp(environment, teardown);
          const old = startDialectStandIn(teardown, 'ferretry-relay/1', appOrigin);
          const { page } = await launchReleaseBrowser(teardown);

          // Act — once per colour scheme, because a failed pairing cannot be reloaded back into view.
          const shown = await pairInEachScheme(page, appOrigin, old.url, 'new-app-old-daemon');

          // Assert — exactly the one sentence that names the MACHINE as the side to update.
          for (const text of shown) should(sentencesShown(text)).eql({ olderDaemon: true, olderApp: false }, text);
          should(old.requests()).containEql('GET /healthz');
        });
      } finally {
        await teardown.closeAll();
      }
    }));

  /**
   * PRODUCT BUG (reported to the e2e lead): an app older than the daemon is told to update the DAEMON.
   *
   * `daemonIsOutdated` (`packages/pwa/src/lib/relay-carrier.ts`) answers "old daemon" for ANY
   * `sessionProtocol` that is not this app's own, so the day a daemon release moves the dialect to
   * `/3`, every app still open on `/2` tells its person to upgrade a machine that is already newer —
   * and to pair again afterwards — while the one action that fixes it, reloading the app, is never
   * mentioned. `OLDER_APP_SENTENCE` exists for exactly this and the app never shows it.
   */
  it('should tell an app paired to a NEWER daemon to update the app', () =>
    retryOnLostBrowser('version-skew', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange
          const appOrigin = await serveApp(environment, teardown);
          const newer = startDialectStandIn(teardown, 'ferretry-relay/3', appOrigin);
          const { page } = await launchReleaseBrowser(teardown);

          // Act
          const shown = await pairInEachScheme(page, appOrigin, newer.url, 'new-app-newer-daemon');

          // Assert — the APP is the side to update.
          for (const text of shown) should(sentencesShown(text)).eql({ olderDaemon: false, olderApp: true }, text);
        });
      } finally {
        await teardown.closeAll();
      }
    }));

  it('should answer an app from before device keys with the one sentence naming the app', () =>
    retryOnLostBrowser('version-skew', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange — the REAL daemon, allowing the app's origin as a real install would.
          const appOrigin = await serveApp(environment, teardown);
          const configPath = join(environment.paths.root, 'daemon.json');
          await writeFile(
            configPath,
            `${JSON.stringify({
              host: '127.0.0.1',
              port: environment.ports.api,
              corsOrigins: [appOrigin],
              carriers: [{ kind: 'relay', source: 'discovery', enabled: false }],
            })}\n`,
            'utf8',
          );
          const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
          const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
          await environment.startDaemon({
            command: [
              process.env.FYD_BIN ?? join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${platform}-${architecture}`),
              '--config',
              configPath,
            ],
            readyUrl: environment.httpUrl('/v1/health'),
            timeoutMs: 60_000,
          });
          const { page } = await launchReleaseBrowser(teardown);
          await page.goto(`${appOrigin}/app`, { waitUntil: 'load', timeout: 60_000 });

          // Act — from the app's own origin, the request an app from before device keys makes: its
          // stored `fy_device_…` bearer token, which no daemon accepts any more.
          const answer = await page.evaluate<{
            status: number;
            body: { error?: string; code?: string };
          }>(`(async () => {
          const response = await fetch('${environment.httpUrl('/v1/sessions')}', {
            headers: { authorization: 'Bearer fy_device_${'B'.repeat(43)}' },
          });
          return { status: response.status, body: await response.json() };
        })()`);

          // Assert — 426, readable cross-origin, and the sentence names the APP and how to update it.
          should(answer.status).equal(426);
          should(answer.body.code).equal('app_outdated');
          should(answer.body.error).equal(OLDER_APP_SENTENCE);
          should(sentencesShown(answer.body.error ?? '')).eql({ olderDaemon: false, olderApp: true });
        });
      } finally {
        await teardown.closeAll();
      }
    }));
});
