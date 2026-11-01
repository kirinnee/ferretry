/**
 * THE WEBRTC CARRIER, END TO END: a real Chrome reaches a compiled daemon peer-to-peer, and falls back
 * to the relay — saying why — when the network will not let it (`docs/relay-protocol.md` §16).
 *
 * Both journeys pair a real Chrome with a freshly compiled `fyd` over a real rendezvous PROCESS, the
 * daemon's direct address a sinkhole, exactly as a phone away from home would. Then the session page:
 *
 *   1. PEER-TO-PEER. With nothing but the default preference (Auto), direct fails, the relay INTRODUCES
 *      the two ends (`POST /v1/webrtc/offer` inside a relayed session), and the page is carried over a
 *      WebRTC data channel: the page names `webrtc` as its carrier, an event the daemon appends after
 *      that reaches the page, and the rendezvous carries no binary frame for it — the session's bytes
 *      went peer-to-peer, not through the relay.
 *   2. NO PATH. The page's `RTCPeerConnection` is wrapped, before any script of the app runs, so every
 *      ICE candidate is removed from the offer it sends and the answer it receives: neither end ever
 *      learns an address of the other, which is what a network with no peer-to-peer path looks like to
 *      ICE. (Chrome's own `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` was tried first and
 *      does NOT stop a loopback connection — measured, the channel opened anyway.) The attempt is
 *      abandoned at the 8-second deadline, the relay carries the page, and the Connection panel says why
 *      a faster carrier is not carrying. Nothing in the product is switched or stubbed; only the path is.
 *
 * Run it:
 *
 *     task compile && CLI_BIN=dist/bin/fy-linux-x64-baseline FY_E2E_REAL_TMUX="$(command -v tmux)" \
 *       bun test tests/e2e/webrtc-carrier.e2e.test.ts --config=bunfig.e2e.toml --timeout 300000
 *
 * WHAT IT DOES NOT PROVE: a NAT. Both peers are on one machine, so ICE pairs host candidates on
 * loopback; traversing a home router or a carrier-grade NAT is the STUN server's half, which no
 * repository-local test can reach. The timings it reports are written to `$FY_E2E_WEBRTC_REPORT`.
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture.ts';
import { seedRunningSession } from './support/seeded-session.ts';
import {
  attributeNow,
  type BrowserPage,
  buildPwaBundle,
  clickFirstPresent,
  harnessTeardown,
  launchChrome,
  type RendezvousProcess,
  startDirectSinkhole,
  startPwaOrigin,
  startRelayDirectory,
  startRendezvous,
  waitForDaemonAtRendezvous,
  waitForDaemonFingerprint,
} from './support/relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const REPORT_PATH = process.env.FY_E2E_WEBRTC_REPORT ?? join(tmpdir(), 'fy-e2e-webrtc-carrier.md');
const FINGERPRINT = /fy_daemon_[A-Za-z0-9_-]{43}/u;
const PAIRING_LINK = /https?:\/\/\S*#v\d;\S+/u;
/**
 * A page script that leaves WebRTC no path: every `a=candidate` line is dropped from the description the
 * page sends and from the one it is given, so ICE has no pair to check in either direction.
 */
const NO_PEER_TO_PEER_PATH = `(() => {
  const Native = window.RTCPeerConnection;
  if (typeof Native !== 'function') return;
  window.__fyNoPeerToPeerPath = true;
  const strip = sdp => sdp.split('\\r\\n').filter(line => !line.startsWith('a=candidate') && !line.startsWith('a=end-of-candidates')).join('\\r\\n');
  const described = description => description === null ? null : { type: description.type, sdp: strip(description.sdp), toJSON() { return { type: description.type, sdp: strip(description.sdp) }; } };
  window.RTCPeerConnection = class extends Native {
    get localDescription() { return described(super.localDescription); }
    setRemoteDescription(description) { return super.setRemoteDescription({ type: description.type, sdp: strip(description.sdp) }); }
  };
})();`;

function compiledDaemon(): string {
  const explicit = process.env.FYD_BIN;
  if (explicit !== undefined && explicit !== '') return resolve(REPOSITORY_ROOT, explicit);
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${platform}-${architecture}`);
}

function daemonDocument(bindPort: number, publicUrl: string, appOrigin: string): string {
  return `${JSON.stringify({ publicUrl, corsOrigins: [appOrigin], carriers: [{ kind: 'bind', host: '127.0.0.1', port: bindPort }] }, null, 2)}\n`;
}

async function note(line: string): Promise<void> {
  await appendFile(REPORT_PATH, `${line}\n`, 'utf8');
}

async function adminToken(environment: E2eEnvironment): Promise<string> {
  return (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
}

/** An event the daemon appends on its own: a send over loopback with the host token. */
async function probe(environment: E2eEnvironment, sessionId: string, message: string): Promise<void> {
  const response = await fetch(environment.httpUrl(`/v1/sessions/${sessionId}/send`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await adminToken(environment)}`,
      'Content-Type': 'application/json',
      'x-fy-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify({ message }),
  });
  await response.text();
}

async function lastSequence(environment: E2eEnvironment, sessionId: string): Promise<number> {
  const response = await fetch(environment.httpUrl(`/v1/sessions/${sessionId}/events?after=0&limit=1000`), {
    headers: { Authorization: `Bearer ${await adminToken(environment)}` },
  });
  const events = (await response.json()) as readonly { readonly sequence: number }[];
  return events.at(-1)?.sequence ?? 0;
}

async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  return undefined;
}

/** Binary frames the rendezvous handled for a client — session bytes, as opposed to heartbeat text. */
async function clientBinaryFrames(rendezvous: RendezvousProcess): Promise<number> {
  return (await rendezvous.observations()).filter(frame => frame.role === 'client' && frame.kind === 'binary').length;
}

interface Journey {
  readonly environment: E2eEnvironment;
  readonly rendezvous: RendezvousProcess;
  readonly page: BrowserPage;
  readonly appOrigin: string;
  readonly session: { readonly sessionId: string };
  readonly fingerprint: string;
  /** When the session page was asked for, in ms since the epoch. */
  readonly openedAt: number;
}

/** Boot every moving part, pair a real Chrome over the relay, open the session page, then run `body`. */
async function withJourney(
  label: string,
  blockPeerToPeer: boolean,
  body: (journey: Journey) => Promise<void>,
): Promise<void> {
  await note(`\n# WebRTC carrier (${label}) — ${new Date().toISOString()}\n`);
  const teardown = harnessTeardown();
  let journeyError: unknown;
  try {
    await withE2eEnvironment(async environment => {
      const daemonBin = compiledDaemon();
      if (!(await Bun.file(daemonBin).exists()))
        throw new Error(`no compiled daemon at ${daemonBin} — run \`task compile\``);
      const rendezvous = await startRendezvous(environment.paths.root, teardown);
      const directory = await startRelayDirectory();
      directory.publish(rendezvous.relayUrl);
      const sinkhole = await startDirectSinkhole(teardown);
      const distDir = await buildPwaBundle(directory.origin);
      const served = await startPwaOrigin(distDir, teardown);
      const appOrigin = served.origin.replace('//127.0.0.1:', '//localhost:');
      const configPath = join(environment.paths.root, 'daemon.json');
      await writeFile(configPath, daemonDocument(environment.ports.api, sinkhole.origin, appOrigin), 'utf8');
      const session = await seedRunningSession(environment.paths.fyHome);
      const realTmux = process.env.FY_E2E_REAL_TMUX ?? '';
      if (realTmux === '') throw new Error('FY_E2E_REAL_TMUX is not set');
      // A send needs a lifecycle-shaped config and a pane to type into, or the daemon refuses it and the
      // journal never grows: a plain `cat` on the daemon's private tmux socket is enough, exactly as the
      // relay reconnect journey does it.
      const tmuxSession = `fy-e2e-webrtc-${Math.trunc(Math.random() * 1e6).toString(36)}`;
      const configFile = join(environment.paths.fyHome, 'state', 'sessions', session.sessionId, 'config.json');
      const seeded = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>;
      const cat = Bun.which('cat');
      if (cat === null) throw new Error('no cat on PATH');
      await writeFile(configFile, `${JSON.stringify({ ...seeded, command: [cat], tmuxSession })}\n`, 'utf8');
      const privateSocket = join(environment.paths.fyHome, 'tmux.sock');
      const pane = Bun.spawnSync([
        realTmux,
        '-S',
        privateSocket,
        'new-session',
        '-d',
        '-s',
        tmuxSession,
        '-x',
        '120',
        '-y',
        '30',
        cat,
      ]);
      if (pane.exitCode !== 0) throw new Error(`could not open the session pane: ${pane.stderr.toString()}`);
      teardown.add('session tmux server', () => {
        Bun.spawnSync([realTmux, '-S', privateSocket, 'kill-server']);
      });
      const daemonCommand = {
        command: [
          '/usr/bin/env',
          `PATH=${dirname(realTmux)}:${process.env.PATH ?? ''}`,
          daemonBin,
          '--config',
          configPath,
        ] as const,
        readyUrl: environment.httpUrl('/v1/health'),
        timeoutMs: 30_000,
        env: { FY_RELAY_DIRECTORY_ORIGIN: directory.origin },
      };
      const seen = await rendezvous.dialled();
      await environment.startDaemon(daemonCommand);
      const fingerprint = await waitForDaemonFingerprint(rendezvous, seen);
      await environment.stopDaemon();
      if (!FINGERPRINT.test(fingerprint)) throw new Error(`malformed fingerprint ${fingerprint}`);
      await rendezvous.allow(fingerprint);
      await environment.startDaemon(daemonCommand);
      await waitForDaemonAtRendezvous(rendezvous);

      // Pair over the relay: the direct address is a sinkhole, as it is for a phone away from home.
      const minted = await environment.runFy(['pair', '--no-wait'], { FY_URL: environment.httpUrl() });
      const link = PAIRING_LINK.exec(`${minted.out}\n${minted.err}`)?.[0];
      if (link === undefined) throw new Error(`fy pair printed no link: ${minted.err.trim()}`);
      const browser = await launchChrome(teardown);
      const page = browser.page;
      // Playwright's own init script, which runs in every document this page loads before the app does.
      // (A DevTools `Page.addScriptToEvaluateOnNewDocument` on the harness's CDP session did not reach the
      // page — measured — so the page wrapper's pass-through to the real Playwright method is used.)
      if (blockPeerToPeer)
        await (page as unknown as { addInitScript(script: string): Promise<void> }).addInitScript(NO_PEER_TO_PEER_PATH);
      await page.goto(`${appOrigin}/pair#${link.slice(link.indexOf('#') + 1)}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      await page.waitForSelector('[data-pairing-stage="confirm"]', { timeout: 20_000 });
      if ((await clickFirstPresent(page, ['[data-pair-confirm]'])) === null) throw new Error('no confirm control');
      await Promise.race([
        page.waitForSelector('[data-pairing-stage="paired"]', { timeout: 45_000 }),
        page.waitForSelector('[data-pairing-stage]', { state: 'detached', timeout: 45_000 }),
      ]);
      await note(
        `- paired over the relay; peer-to-peer path ${blockPeerToPeer ? 'BLOCKED (no ICE candidates)' : 'open'}`,
      );

      const openedAt = Date.now();
      await page.goto(`${appOrigin}/d/${fingerprint}/session/${session.sessionId}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      await body({ environment, rendezvous, page, appOrigin, session, fingerprint, openedAt });
    });
  } catch (error) {
    journeyError = error;
  } finally {
    await teardown.closeAll().catch((error: unknown) => {
      journeyError ??= error;
    });
  }
  if (journeyError !== undefined) {
    const written = await readFile(REPORT_PATH, 'utf8').catch(() => '');
    throw new Error(`${(journeyError as Error).message}\n\n--- report (${REPORT_PATH}) ---\n${written}`, {
      cause: journeyError,
    });
  }
}

describe('the WebRTC carrier, in a real browser against a compiled daemon', () => {
  it(
    'should carry the session page peer-to-peer, introduced by the relay, with no session bytes on the relay [slow]',
    () =>
      withJourney(
        'peer-to-peer',
        false,
        async ({ environment, rendezvous, page, appOrigin, fingerprint, session, openedAt }) => {
          // The page settles on WebRTC: direct failed (sinkhole), the relay introduced, the channel opened.
          const settled = await page.waitForSelector('[data-carrier-kind="webrtc"]', { timeout: 45_000 }).then(
            () => true,
            () => false,
          );
          if (!settled) {
            // Say what the page settled on and why, from its own Connection panel, before failing.
            const carrier = await attributeNow(page, '[data-carrier-kind]', 'data-carrier-kind');
            await page.goto(`${appOrigin}/d/${fingerprint}/settings#machines//machine/carrier`, {
              waitUntil: 'networkidle',
            });
            await Bun.sleep(15_000);
            const panel = await page.evaluate<string | null>(
              `document.querySelector('[data-carrier-kind]')?.closest('section')?.innerText ?? null`,
            );
            await note(
              `- WebRTC never carried; the page settled on ${String(carrier)}; Connection panel:\n${String(panel)}`,
            );
            throw new Error('the session page never settled on WebRTC');
          }
          const carriedAfter = Date.now() - openedAt;
          await page.waitForSelector('[data-live-events]', { timeout: 30_000 });
          await note(`- the page named WebRTC as its carrier ${String(carriedAfter)} ms after it was asked for`);

          // Let the page's first burst settle, then watch the relay while the daemon appends an event.
          await Bun.sleep(3_000);
          const framesBefore = await clientBinaryFrames(rendezvous);
          const target = (await lastSequence(environment, session.sessionId)) + 1;
          const appendedAt = Date.now();
          await probe(environment, session.sessionId, `webrtc-probe-${Math.trunc(Math.random() * 1e9).toString(36)}`);
          if ((await lastSequence(environment, session.sessionId)) < target)
            await note('  - WARNING: the probe appended no journal event');
          const reached = await until(async () => {
            const raw = await attributeNow(page, '[data-live-events]', 'data-live-events');
            return Number(raw) >= target ? Date.now() : undefined;
          }, 20_000);
          await Bun.sleep(1_000);
          const framesAfter = await clientBinaryFrames(rendezvous);
          const carrier = await attributeNow(page, '[data-carrier-kind]', 'data-carrier-kind');
          await note(
            `- an event appended by the daemon reached the page ${reached === undefined ? 'NEVER (20 s)' : `${String(reached - appendedAt)} ms later`}; ` +
              `client binary frames on the relay meanwhile: ${String(framesAfter - framesBefore)}; carrier still: ${String(carrier)}`,
          );

          // Assert
          should(reached).not.be.undefined();
          should(carrier).equal('webrtc');
          should(framesAfter - framesBefore).equal(0);
        },
      ),
    300_000,
  );

  it(
    'should fall back to the relay at the deadline when there is no peer-to-peer path, and say why [slow]',
    () =>
      withJourney('no-path', true, async ({ page, appOrigin, fingerprint, openedAt }) => {
        // The relay carries the page: WebRTC gathered nothing ICE could use and was abandoned.
        const relayed = await page.waitForSelector('[data-carrier-kind="relay"]', { timeout: 60_000 }).then(
          () => true,
          () => false,
        );
        if (!relayed) {
          const carrier = await attributeNow(page, '[data-carrier-kind]', 'data-carrier-kind');
          const glass = await page.evaluate<string>(
            `'shim=' + String(window.__fyNoPeerToPeerPath) + ' ' + document.body.innerText.slice(0, 200)`,
          );
          await note(`- the relay never carried; the page shows carrier ${String(carrier)}:\n${glass}`);
          throw new Error('the session page never fell back to the relay');
        }
        const relayedAfter = Date.now() - openedAt;
        await page.waitForSelector('[data-live-events]', { timeout: 30_000 });
        await note(`- the page named the relay as its carrier ${String(relayedAfter)} ms after it was asked for`);

        // The Connection panel names the reason a faster carrier is not carrying.
        // `#machines//machine/carrier`: the empty machine segment is "the machine this page is for".
        await page.goto(`${appOrigin}/d/${fingerprint}/settings#machines//machine/carrier`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        const reason = await until(async () => {
          const text = await page.evaluate<string | null>(
            `document.querySelector('[data-carrier-fallback-reason]')?.textContent ?? null`,
          );
          return text === null ? undefined : text;
        }, 30_000);
        await note(`- the Connection panel says: ${String(reason)}`);

        // Assert
        should(reason).match(/no direct path found in 8 s/u);
      }),
    300_000,
  );
});
