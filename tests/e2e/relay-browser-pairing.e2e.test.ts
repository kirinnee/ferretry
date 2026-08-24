/**
 * THE OWNER'S BAR, EXECUTED: a real Chrome pairs with a compiled daemon over a real relay, and
 * then receives something live.
 *
 * Every other tier stops short of this on purpose, and each stops short somewhere different:
 *
 *   - each package's `tests/unit` proves its half against scripted frames — no interop.
 *   - `packages/pwa/tests/integration/relay-carrier-end-to-end.test.ts` wires the browser client,
 *     the real rendezvous and the real daemon link together with real WebCrypto — but all three are
 *     objects in ONE process, driven by explicit calls. No socket, no browser, no binary.
 *   - the PWA's `.visual.test.tsx` integration tests launch real Chrome — at
 *     `renderToStaticMarkup` output. The app is never running, so it can never pair with anything.
 *   - `packages/cli/tests/sit` drives the compiled binary — with no browser anywhere.
 *
 * So this file exists to hold the ONE claim none of them can make, and it is deliberately
 * assembled out of things that are real rather than things that are convenient:
 *
 *   REAL compiled `fyd` binary from `task compile`, in an isolated state home
 *   REAL rendezvous — `packages/relay`'s own front door and Durable Object, in its own OS process,
 *        speaking real WebSockets (see `scripts/test/rendezvous-process.ts` for what Bun substitutes)
 *   REAL PWA bundle from `vite build`, served over HTTP under the published site's own CSP
 *   REAL Google Chrome, driven by `playwright-core`
 *   REAL failure of the direct address, arranged rather than assumed
 *   REAL directory advertisement on loopback, which is how BOTH ends learn one rendezvous — nothing
 *        here is told an address, so this is the shipped default rather than a spelling of it
 *
 * ── THE STEP LEDGER, AND WHY IT IS SHAPED LIKE THIS ────────────────────────────────────────────
 *
 * Every claim is named up front, recorded as it passes, and written to `$FY_E2E_RELAY_REPORT` on
 * every run. A failing run names the step that broke — not the earliest step that was never
 * reached, which sends the reader to the wrong package.
 *
 * That shape earned itself several times over while this was being built. It located a
 * release-blocking CLI regression (`fy pair` refusing the daemon's own link when the fragment briefly
 * gained a second version, so the operator got no code by any route), and a §14 stream session that
 * opened over the rendezvous and carried no frames — both in builds where every in-process tier was
 * green. The failure messages carry the
 * discriminator rather than the symptom: "a stream session WAS opened and carried no frames" and
 * "NO stream session was ever opened" are defects in different packages.
 *
 * The first test below guards every moving part of the harness itself, so a red journey stays a
 * statement about the product rather than about the scaffolding.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────────────────────────────
 *
 *     task compile && task test:e2e
 *     # or just this file:
 *     CLI_BIN=dist/bin/fy-linux-x64-baseline FY_E2E_REAL_TMUX="$(command -v tmux)" \
 *       bun test tests/e2e/relay-browser-pairing.e2e.test.ts --config=bunfig.e2e.toml --timeout 180000
 *
 * The written report lands at `$FY_E2E_RELAY_REPORT` (default `<tmpdir>/fy-e2e-relay-journey.md`)
 * and is also printed on failure, because a report in a directory nobody looks in is not a report.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture.ts';
import { seedRunningSession } from './support/seeded-session.ts';
import {
  attributeNow,
  buildPwaBundle,
  chromeExecutable,
  clickFirstPresent,
  describeControls,
  deviceTokenForLeakSearchOnly,
  harnessTeardown,
  HOSTED_RELAY_PUBLIC_PATH,
  launchChrome,
  type LedgerStep,
  plaintextLeaks,
  renderedDataAttributes,
  startDirectSinkhole,
  startPwaOrigin,
  startRelayDirectory,
  type RendezvousProcess,
  startRendezvous,
  stepLedger,
  type StepLedger,
  waitForClientArrivals,
  waitForDaemonAtRendezvous,
  waitForDaemonFingerprint,
} from './support/relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const REPORT_PATH = process.env.FY_E2E_RELAY_REPORT ?? join(tmpdir(), 'fy-e2e-relay-journey.md');

/** The compiled daemon, named the way `scripts/release/compile.sh` names it. */
function compiledDaemon(): string {
  const explicit = process.env.FYD_BIN;
  if (explicit !== undefined && explicit !== '') return resolve(REPOSITORY_ROOT, explicit);
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${platform}-${architecture}`);
}

/**
 * The daemon's configuration, written OUTSIDE the state home and read with `--config`.
 *
 * Not a taste: a `config/daemon.json` placed into an empty `FY_HOME` makes that home "non-empty
 * with no layout-version marker", and the daemon refuses to open it and tells you to run
 * `fy daemon adopt`. `--config` is the documented way to hand a document to a daemon whose home it
 * does not live in, and it leaves first-boot bootstrap exactly as a real first boot.
 */
interface DaemonDocument {
  readonly bindPort: number;
  /** The address the daemon ADVERTISES — the sinkhole, which no browser can use. */
  readonly publicUrl: string;
  readonly appOrigin: string;
}

/**
 * The document a DEFAULT INSTALL has, which is the whole point of its shape.
 *
 * IT DECLARES NO RENDEZVOUS. It used to carry `{ kind: 'relay', url: … }` plus an explicit
 * `{ source: 'discovery', enabled: false }`, and that arrangement proved a spelling nobody ships: the
 * daemon was TOLD its rendezvous and the browser read it out of a `v2` fragment field. Omitting both
 * lines leaves the discovery default, so this daemon reads the stub directory advertisement at boot —
 * the same advertisement the compiled bundle reads — and the two ends arrive at ONE rendezvous with
 * nothing passing between them but a fingerprint. `FY_RELAY_DIRECTORY_ORIGIN` points that read at
 * loopback, so nothing here reaches a real service, which is what the `enabled: false` line was for.
 */
function daemonDocument(input: DaemonDocument): string {
  return `${JSON.stringify(
    {
      publicUrl: input.publicUrl,
      // The app origin is a real origin here rather than the published site, so a direct attempt
      // fails at TRANSPORT against the sinkhole instead of being refused earlier by CORS — which
      // would prove a different thing, and a weaker one.
      corsOrigins: [input.appOrigin],
      carriers: [{ kind: 'bind', host: '127.0.0.1', port: input.bindPort }],
    },
    null,
    2,
  )}\n`;
}

const FINGERPRINT = /fy_daemon_[A-Za-z0-9_-]{43}/u;
const PAIRING_LINK = /https?:\/\/\S*#v\d;\S+/u;

/**
 * How the reader says yes, in order of how much the app has promised about each.
 *
 * A pairing arrival is a CONFIRMATION screen, not an automatic redemption — the reader is being
 * asked which machine they are pairing with, which is deliberate and must not be scaffolded around.
 * So the harness has to press something, and pressing the wrong thing looks identical to an app
 * that ignored the click.
 *
 * Every candidate here names the PRIMARY action specifically. A bare `button` fallback was tried and
 * removed: the pairing frame is embedded in the setup shell, so it matched a navigation control, the
 * flow advanced to the setup summary, and the report said the pairing screen had vanished — a
 * harness defect wearing a product defect's clothes. Failing loudly with the list of controls the
 * screen offers is worth more than a click that lands somewhere.
 */
const CONFIRM_CONTROLS: readonly string[] = [
  // `data-pair-confirm` is on the "Pair this device" button as of `051e5c04`. The
  // `button[data-variant="primary"]` fallback that carried this before is deliberately gone: a
  // design-system attribute is not a contract, and keeping it would let a rename of the real one
  // pass silently by falling through to a button that merely looks important.
  '[data-pair-confirm]',
];

/**
 * A token this run invented, so an absence assertion has something to be absent.
 *
 * "The event payload never reaches the relay" is unfalsifiable against ordinary words: they are too
 * common for a search over binary frames to mean anything, and a false negative reads as a passing
 * privacy assertion. A per-run marker makes every hit real and every miss real. It is used only
 * where the harness genuinely chooses the value — never to dress up a value the product fixes; see
 * {@link PAIRED_DEVICE_NAME}.
 */
function runMarker(kind: string): string {
  return `FyE2e${kind}${Math.trunc(Math.random() * 1e12).toString(36)}`;
}

/**
 * What the browser calls itself when it redeems, and why it is a LITERAL here.
 *
 * `packages/pwa/src/lib/store.tsx` sends the constant `Ferretry PWA`. It does not derive a name
 * from the user agent, so making the agent unique and then searching the relay's frames for that
 * marker would assert the absence of a string nothing ever sent — a privacy check that passes
 * because it tests nothing. Searching for the real value is the only version of this assertion that
 * can fail, and the product is deliberately not changed to make it prettier: a test-only seam that
 * made the device name unique would be a seam shipped for a test.
 *
 * Twelve bytes is short, but this is a search over ciphertext for an exact byte run — a false
 * positive would be a coincidence at roughly one in 2^96, and a real hit would be a real leak.
 */
const PAIRED_DEVICE_NAME = 'Ferretry PWA';

/** Where the daemon lists the devices it has paired. Names, never tokens, never digests. */
const PAIRED_DEVICES_PATH = '/v1/pair/devices';

/**
 * Park or resume a session, which is what appends a durable journal event.
 *
 * The signal route is the cheapest thing in the product that produces a live event: it transitions
 * state, appends, and does nothing else — no terminal port, no artifacts, no harness turn. Fired
 * over loopback with the host token, because what this journey is proving is that the EVENT reaches
 * the browser over the relay, not that the trigger did.
 *
 * `waiting` carries the run marker so the leak search has a value it can look for that nothing else
 * on this host could have produced.
 */
interface SignalSessionResult {
  readonly ok: boolean;
  readonly status: number;
  readonly session?: {
    readonly state: {
      readonly status: string;
      readonly reason?: string;
    };
  };
}

/** The subset of the daemon's durable replay envelope this journey attributes to Chrome. */
interface DurableSessionEvent {
  readonly sequence: number;
  readonly sessionId: string;
  readonly type: string;
  readonly data: unknown;
}

async function signalSession(
  environment: E2eEnvironment,
  sessionId: string,
  kind: 'waiting' | 'working',
  marker: string,
): Promise<SignalSessionResult> {
  const token = (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
  const response = await fetch(environment.httpUrl(`/v1/sessions/${sessionId}/signal`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(kind === 'waiting' ? { kind, message: marker } : { kind }),
  });
  return {
    ok: response.ok,
    status: response.status,
    ...(response.ok ? { session: (await response.json()) as SignalSessionResult['session'] } : {}),
  };
}

/** Read the daemon's own journal projection, not the browser's eventually-consistent live feed. */
async function sessionEvents(
  environment: E2eEnvironment,
  sessionId: string,
  afterSequence: number,
): Promise<readonly DurableSessionEvent[]> {
  const token = (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
  const response = await fetch(
    environment.httpUrl(`/v1/sessions/${sessionId}/events?after=${String(afterSequence)}&limit=1000`),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok)
    throw new Error(
      `the daemon refused its durable event replay after ${String(afterSequence)} with ${String(response.status)}: ` +
        `${(await response.text()).slice(0, 400)}`,
    );
  return (await response.json()) as readonly DurableSessionEvent[];
}

/** CSS has no numeric attribute comparison; excluding every lower cursor value is an exact ≥ wait. */
function liveCursorAtLeast(sequence: number): string {
  return (
    '[data-live-events]' +
    Array.from({ length: sequence }, (_, lower) => `:not([data-live-events="${String(lower)}"])`).join('')
  );
}

/** Everything the journey claims, in the order it can be claimed. */
const STEPS: readonly LedgerStep[] = [
  { id: 'compiled-artifacts', claim: 'the compiled fy and fyd binaries exist and are executable' },
  { id: 'rendezvous-refuses-strangers', claim: 'the rendezvous 404s a fingerprint its operator never listed' },
  { id: 'daemon-fingerprint', claim: 'the compiled daemon booted an isolated home and minted a relay identity' },
  { id: 'daemon-claims-rendezvous', claim: 'the compiled daemon holds a real WebSocket at the rendezvous' },
  {
    id: 'direct-is-unreachable',
    claim: 'the advertised direct address accepts a connection and then fails at transport',
  },
  { id: 'pairing-link-minted', claim: 'the compiled CLI printed a pairing link the host can hand out' },
  { id: 'browser-loads-app', claim: 'real Chrome loaded the real bundle at /pair and reached the confirm stage' },
  {
    id: 'pairing-link-carries-no-relay',
    claim: 'the minted link is v1, advertises the sinkhole, and names no rendezvous at all',
  },
  {
    id: 'browser-discovered-the-rendezvous',
    claim: 'the browser read the directory advertisement, which is the only place it could learn a relay',
  },
  { id: 'browser-tried-direct', claim: 'the browser attempted the advertised direct address and it failed' },
  {
    id: 'browser-paired-over-relay',
    claim: 'the pairing screen reports paired, and the rendezvous carried a client session',
  },
  {
    id: 'pairing-persisted',
    claim: 'both ends recorded the pairing, and the daemon names the device, without reading a credential',
  },
  {
    id: 'authenticated-relay-session',
    claim: 'a second, authenticated session followed the pairing across the same rendezvous',
  },
  {
    id: 'relay-read-nothing',
    claim: 'no pairing code, device token or device name appears in any relay-observable frame',
  },
  {
    id: 'live-stream-rendered',
    claim: 'a real daemon event reached Chrome, and its payload appears in no relay-observable frame',
  },
  {
    id: 'lost-stream-is-visible',
    claim: 'the daemon going away stops the page claiming to be live and says so on screen instead',
  },
  {
    id: 'live-stream-recovers',
    // NOT "resumed at the cursor rather than from zero" — the relay's records are sealed, so no
    // observer here can read the `after` this subscription sent. What a browser can show is that the
    // page picked the daemon back up unaided and moved on from the cursor it was holding.
    claim: 'the returning daemon is picked back up unaided, and the never-reloaded page advances from its held cursor',
  },
];

async function reportAndRethrow(error: unknown, report: string): Promise<never> {
  const written = await readFile(report, 'utf8').catch(() => '');
  throw new Error(`${(error as Error).message}\n\n--- ledger (${report}) ---\n${written}`, { cause: error });
}

/** The pairing fragment, re-hosted on the origin this run actually serves. */
function rehost(link: string, appOrigin: string): { readonly url: string; readonly fragment: string } {
  const hash = link.indexOf('#');
  if (hash === -1) throw new Error(`the minted pairing link carries no fragment: ${link}`);
  const fragment = link.slice(hash + 1);
  return { url: `${appOrigin}/pair#${fragment}`, fragment };
}

function fragmentField(fragment: string, name: string): string | undefined {
  for (const part of fragment.split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at) === name) return decodeURIComponent(part.slice(at + 1));
  }
  return undefined;
}

/**
 * Boot the compiled daemon twice, which is what a self-hosted relay's allowlist costs.
 *
 * A deployment refuses a fingerprint its operator never listed, and this run's fingerprint does not
 * exist until a daemon has opened this state home once. So the first boot exists to mint an
 * identity and say it out loud on the boot trail, and the second is the one that gets in. Keeping
 * the refusal rather than pre-seeding a fingerprint is deliberate: it is the property that makes a
 * self-hosted rendezvous worth running, and a harness that switched it off would not notice it
 * breaking.
 */
async function bootAndLearnFingerprint(
  environment: E2eEnvironment,
  configPath: string,
  rendezvous: RendezvousProcess,
  directoryOrigin: string,
): Promise<string> {
  const before = await rendezvous.dialled();
  await environment.startDaemon({
    command: [compiledDaemon(), '--config', configPath],
    readyUrl: environment.httpUrl('/v1/health'),
    timeoutMs: 30_000,
    // The daemon's own escape hatch, pointed at the stub. Its default would be the production origin,
    // which this journey must never dial.
    env: { FY_RELAY_DIRECTORY_ORIGIN: directoryOrigin },
  });
  // Wait for the DIAL, not for the listener. `/v1/health` answering means the HTTP surface is up;
  // the relay identity is announced afterwards, so stopping at readiness raced the announcement and
  // reported a daemon with no relay identity on a loaded machine.
  const fingerprint = await waitForDaemonFingerprint(rendezvous, before);
  await environment.stopDaemon();
  if (!FINGERPRINT.test(fingerprint)) throw new Error(`the rendezvous saw a malformed fingerprint: ${fingerprint}`);
  return fingerprint;
}

describe('a real browser, a compiled daemon and a real relay', () => {
  it('should stand up every moving part of the relay journey harness', async () => {
    // Arrange
    const teardown = harnessTeardown();
    try {
      await withE2eEnvironment(async environment => {
        const rendezvous = await startRendezvous(environment.paths.root, teardown);
        const directory = await startRelayDirectory();
        directory.publish(rendezvous.relayUrl);
        const directoryReadsBeforeDaemon = directory.reads();
        const directoryRequestsBeforeDaemon = directory.requests().length;
        const sinkhole = await startDirectSinkhole(teardown);
        const configPath = join(environment.paths.root, 'daemon.json');

        // Act — the rendezvous, the directory, the compiled daemon, the sinkhole, the bundle and
        // Chrome, in turn.
        const stranger = await fetch(`${rendezvous.httpOrigin}/v1/rendezvous/fy_daemon_${'A'.repeat(43)}/daemon`, {
          headers: { Upgrade: 'websocket' },
        });

        await writeFile(
          configPath,
          daemonDocument({
            bindPort: environment.ports.api,
            publicUrl: sinkhole.origin,
            appOrigin: 'http://127.0.0.1:1',
          }),
          'utf8',
        );
        const fingerprint = await bootAndLearnFingerprint(environment, configPath, rendezvous, directory.origin);
        await rendezvous.allow(fingerprint);
        await environment.startDaemon({
          command: [compiledDaemon(), '--config', configPath],
          readyUrl: environment.httpUrl('/v1/health'),
          timeoutMs: 30_000,
          env: { FY_RELAY_DIRECTORY_ORIGIN: directory.origin },
        });
        await waitForDaemonAtRendezvous(rendezvous);
        const directoryReadsByDaemon = directory.reads() - directoryReadsBeforeDaemon;
        const directoryRequestsByDaemon = directory.requests().slice(directoryRequestsBeforeDaemon);

        const directFailure = await fetch(`${sinkhole.origin}/v1/health`).then(
          () => undefined,
          (error: unknown) => error,
        );

        const distDir = await buildPwaBundle(directory.origin);
        const origin = await startPwaOrigin(distDir, teardown);
        const browser = await launchChrome(teardown);
        await browser.page.goto(`${origin.origin}/pair`, { waitUntil: 'networkidle', timeout: 30_000 });
        const title = await browser.page.evaluate<string>('document.title');
        /**
         * `textContent`, NOT `innerText`, and the difference is the whole assertion.
         *
         * This read `document.body.innerText`, which is LAYOUT-dependent: it reports the text a reader
         * would see, so an element of zero measured height contributes nothing to it. The app shell is
         * fixed-height and `#root` measures 0 in this headless context even though React has rendered —
         * `body` is 900px, `--app-h` is 900px, `#root` is 0 — so this step asserted "the browser laid
         * the app out the way a phone would" while claiming to assert "the app rendered". It failed on
         * a bundle with none of this branch's changes in it, which is how the substitution was found.
         * `textContent` is what "React mounted and produced content" means and cannot be moved by a
         * viewport.
         */
        const bodyText = await browser.page.evaluate<string>('document.body.textContent.trim().slice(0, 400)');
        const rendered = bodyText.length;

        // Assert
        should(stranger.status).equal(404);
        should(fingerprint).match(FINGERPRINT);
        should((await rendezvous.sockets()).some(row => row.roles.includes('daemon'))).be.true();
        // The daemon reached the rendezvous WITHOUT being told its address, so the stub directory is
        // wired: an unread advertisement would leave a direct-only daemon and no socket above. The
        // paths asked for are in the message because a wrong PATH and a wrong ORIGIN are different
        // harness defects and the count alone cannot tell them apart.
        should(directoryReadsByDaemon).be.greaterThan(
          0,
          `the daemon read no advertisement at ${directory.origin}; it asked for ${directoryRequestsByDaemon.join(', ') || 'nothing'}`,
        );
        should(directFailure).be.an.Error();
        should(sinkhole.attempts()).be.greaterThan(0);
        should(chromeExecutable()).not.be.empty();
        should(title).not.be.empty();
        // A page error and a missing asset BEFORE the rendered-length check, deliberately: both explain
        // an empty body, and asserting the symptom first reports "0 is not above 0" about a page whose
        // real failure is one line further down.
        should(browser.pageErrors).be.empty();
        should(origin.missingAssets()).be.empty();
        should(rendered).be.greaterThan(0, `the cold /pair document rendered no content: ${JSON.stringify(bodyText)}`);
        should((await rendezvous.observations()).length).be.greaterThan(0);
      });
    } finally {
      await teardown.closeAll();
    }
  }, 240_000);

  it('should carry a first pairing and a live stream over the relay', async () => {
    // Arrange
    const teardown = harnessTeardown();
    const ledger: StepLedger = stepLedger(STEPS);
    await writeFile(REPORT_PATH, '', 'utf8');
    const eventMarker = runMarker('Event');
    let journeyError: unknown;

    try {
      await withE2eEnvironment(async environment => {
        const daemonBin = compiledDaemon();
        const fyBin = join(
          REPOSITORY_ROOT,
          'dist',
          'bin',
          `fy-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64-baseline'}`,
        );
        if (!(await Bun.file(daemonBin).exists()))
          ledger.fail('compiled-artifacts', `no compiled daemon at ${daemonBin} — run \`task compile\``);
        if (!(await Bun.file(fyBin).exists()) && (process.env.CLI_BIN ?? '') === '') {
          ledger.fail('compiled-artifacts', `no compiled CLI at ${fyBin} — run \`task compile\``);
        }
        ledger.prove('compiled-artifacts', `${daemonBin} and the compiled CLI are present`);

        const rendezvous = await startRendezvous(environment.paths.root, teardown);
        const stranger = await fetch(`${rendezvous.httpOrigin}/v1/rendezvous/fy_daemon_${'A'.repeat(43)}/daemon`, {
          headers: { Upgrade: 'websocket' },
        });
        if (stranger.status !== 404) {
          ledger.fail(
            'rendezvous-refuses-strangers',
            `an unlisted fingerprint got ${String(stranger.status)}, not 404`,
          );
        }
        ledger.prove('rendezvous-refuses-strangers', `unlisted fingerprint → 404 at ${rendezvous.httpOrigin}`);

        /**
         * ONE ADVERTISEMENT, READ BY BOTH ENDS — which is the shipped default path, spelled here.
         *
         * Nothing tells the daemon its rendezvous and nothing tells the browser: the compiled bundle
         * carries this origin as its directory constant and the compiled daemon is pointed at the same
         * origin, so each finds the address for itself. Published now, before either end boots, because
         * the daemon reads it once at startup.
         */
        const directory = await startRelayDirectory();
        directory.publish(rendezvous.relayUrl);

        const sinkhole = await startDirectSinkhole(teardown);
        const distDir = await buildPwaBundle(directory.origin);
        const origin = await startPwaOrigin(distDir, teardown);
        const configPath = join(environment.paths.root, 'daemon.json');
        await writeFile(
          configPath,
          daemonDocument({
            bindPort: environment.ports.api,
            publicUrl: sinkhole.origin,
            appOrigin: origin.origin,
          }),
          'utf8',
        );

        // Seeded BEFORE the daemon opens the home, which is the ordering the whole thing rests on:
        // the compiled daemon then reads these documents back through the same schemas that wrote
        // them. See `support/seeded-session.ts` for what this substitutes and what it does not.
        const session = await seedRunningSession(environment.paths.fyHome);
        const fingerprint = await bootAndLearnFingerprint(environment, configPath, rendezvous, directory.origin).catch(
          (error: unknown) => ledger.fail('daemon-fingerprint', String(error)),
        );
        ledger.prove('daemon-fingerprint', `the compiled daemon minted ${fingerprint}`);

        await rendezvous.allow(fingerprint);
        await environment.startDaemon({
          command: [daemonBin, '--config', configPath],
          readyUrl: environment.httpUrl('/v1/health'),
          timeoutMs: 30_000,
          env: { FY_RELAY_DIRECTORY_ORIGIN: directory.origin },
        });
        await waitForDaemonAtRendezvous(rendezvous).catch((error: unknown) =>
          ledger.fail('daemon-claims-rendezvous', String(error)),
        );
        ledger.prove(
          'daemon-claims-rendezvous',
          `the rendezvous holds a daemon socket for ${fingerprint}, discovered from the advertisement rather than declared`,
        );
        // Read BEFORE the browser loads, so the browser's own reads can be told apart from the daemon's.
        const directoryReadsBeforeBrowser = directory.reads();

        const directProbe = await fetch(`${sinkhole.origin}/v1/health`).then(
          () => 'answered',
          (error: unknown) => String(error),
        );
        if (directProbe === 'answered' || sinkhole.attempts() === 0) {
          ledger.fail(
            'direct-is-unreachable',
            `the advertised direct address ${sinkhole.origin} did not fail at transport`,
          );
        }
        ledger.prove(
          'direct-is-unreachable',
          `${sinkhole.origin} accepted ${String(sinkhole.attempts())} connection(s) and answered none`,
        );

        /**
         * ONE command, and the browser redeems the credential THAT command printed.
         *
         * The link is scraped from the compiled CLI's own screen and handed to Chrome unchanged. It
         * is deliberately not re-minted through the daemon's HTTP pairing-code route: a second mint
         * is a second code, and the journey would then prove that *a* credential can be redeemed
         * rather than that the one an operator was actually shown is the one that works. It also
         * keeps the host-rendered screen on the critical path — which is where a fragment reader that
         * spelled its own version was caught, in a build where every other half was already correct.
         */
        const minted = await environment.runFy(['pair', '--no-wait'], { FY_URL: environment.httpUrl() });
        const link = PAIRING_LINK.exec(`${minted.out}\n${minted.err}`)?.[0];
        if (link === undefined) {
          ledger.fail(
            'pairing-link-minted',
            `\`fy pair --no-wait\` printed no link (exit ${String(minted.code)}): ${minted.err.trim()}`,
          );
        }
        ledger.prove('pairing-link-minted', 'the compiled CLI rendered a pairing link on the host screen');
        const { url: pairUrl, fragment } = rehost(link, origin.origin);
        const code = fragmentField(fragment, 'code') ?? '';
        const advertised = fragmentField(fragment, 'url') ?? '';
        const relayField = fragmentField(fragment, 'relay');

        /**
         * The browser reads the link BEFORE the fragment's shape is asserted, deliberately.
         *
         * The confirm stage does not depend on which carrier the answer will take — the reader is being
         * asked which machine they are pairing with. Checking the app first means a screen defect and a
         * mint defect cannot hide behind one another, and each unit sees its own gap named.
         */
        const browser = await launchChrome(teardown);
        await browser.page.goto(pairUrl, { waitUntil: 'networkidle', timeout: 30_000 });
        const stage = await browser.page
          .waitForSelector('[data-pairing-stage="confirm"]', { timeout: 20_000 })
          .then(() => 'confirm')
          .catch(async () => String(await attributeNow(browser.page, '[data-pairing-stage]', 'data-pairing-stage')));
        const missing = origin.missingAssets();
        if (missing.length !== 0) {
          ledger.fail('browser-loads-app', `the bundle asked for ${missing.join(', ')} and got 404`);
        }
        if (stage !== 'confirm') {
          // Say what the page DID put on the glass. "It is not there" is unactionable; the list of
          // `data-*` names the app actually rendered is the difference between a bug report and a
          // shrug, and the pairing surface is being written while this runs.
          const attributes = await renderedDataAttributes(browser.page);
          ledger.fail(
            'browser-loads-app',
            `the pairing screen never reached data-pairing-stage="confirm" (saw ${stage}). ` +
              `The page rendered these data attributes: ${attributes || 'none'}. ` +
              `Page errors: ${browser.pageErrors.join(' | ') || 'none'}`,
          );
        }
        ledger.prove('browser-loads-app', `Chrome reached data-pairing-stage="confirm" at ${pairUrl}`);

        /**
         * THE LINK CARRIES NO RENDEZVOUS, and this step is the inverse of what it used to assert.
         *
         * It demanded a `v2` fragment whose `relay=` was this run's rendezvous. That form is withdrawn:
         * a QR that named an arbitrary carrier address is the deferred general case, and relayed first
         * pairing ships on the ordinary link because the scanning device discovers the rendezvous
         * itself. So the assertion inverts — one version, no `relay=` — and the step below proves the
         * device really did find the address by the only route left to it.
         */
        if (!fragment.startsWith('v1;')) {
          ledger.fail(
            'pairing-link-carries-no-relay',
            `the daemon minted a ${fragment.split(';')[0] ?? '?'} link. The shipped fragment is the one v1 form; ` +
              'a second version would be a reader nobody has shipped.',
          );
        }
        if (relayField !== undefined) {
          ledger.fail(
            'pairing-link-carries-no-relay',
            `the fragment carries relay=${relayField}. A rendezvous must never enter the QR — the device ` +
              'discovers one from its own build, and a named address would be the deferred general case.',
          );
        }
        if (!advertised.startsWith(sinkhole.origin)) {
          ledger.fail(
            'pairing-link-carries-no-relay',
            `the fragment advertises ${advertised}, not the unreachable ${sinkhole.origin}`,
          );
        }
        ledger.prove(
          'pairing-link-carries-no-relay',
          `v1 fragment advertising the unreachable ${advertised} and naming no rendezvous`,
        );

        /**
         * THE DEVICE FOUND THE RENDEZVOUS ITSELF, and there is nowhere else it could have found it.
         *
         * The fragment names none (proved above), the direct address is a sinkhole, and the bundle
         * holds no relay address of its own — only this run's directory ORIGIN, compiled in. So a read
         * of the hosted advertisement from the browser is the whole of how it learned where to dial, and
         * counting reads is what turns "it crossed the relay" into "it crossed the relay by the shipped
         * route". Measured against the count taken before Chrome launched, so the daemon's own boot read
         * cannot be mistaken for the browser's.
         */
        const browserDirectoryReads = directory.reads() - directoryReadsBeforeBrowser;
        if (browserDirectoryReads <= 0) {
          ledger.fail(
            'browser-discovered-the-rendezvous',
            `Chrome never read ${directory.origin}${HOSTED_RELAY_PUBLIC_PATH} (${String(directory.reads())} total reads, ` +
              `${String(directoryReadsBeforeBrowser)} of them the daemon's). The bundle's directory constant is ` +
              `either unset or pointing elsewhere, so the app has no rendezvous it could dial. It asked for: ` +
              `${directory.requests().join(', ') || 'nothing'}`,
          );
        }
        ledger.prove(
          'browser-discovered-the-rendezvous',
          `Chrome read the advertisement at ${directory.origin} ${String(browserDirectoryReads)} time(s), which is the ` +
            `only place a v1 link and a sinkhole direct address leave it to learn ${rendezvous.relayUrl}`,
        );

        const directBefore = sinkhole.attempts();
        const pressed = await clickFirstPresent(browser.page, CONFIRM_CONTROLS);
        if (pressed === null) {
          ledger.fail(
            'browser-paired-over-relay',
            `nothing on the confirm screen matched a primary action. It offers: ${await describeControls(browser.page, '[data-pairing-stage]')}`,
          );
        }
        /**
         * The screen settles either by SAYING paired or by leaving.
         *
         * `data-pairing-stage="paired"` is the standalone screen's resting state, but this arrival
         * renders EMBEDDED in the setup shell, and a successful pairing lets that shell advance to
         * its own summary — so the pairing frame unmounts and the attribute disappears. Waiting only
         * for `paired` therefore times out on the success path. Which of the two happened is settled
         * below by state the screen does not own: the daemon's device list, the browser's registry
         * mirror, and the rendezvous' record of who arrived.
         */
        const paired = await Promise.race([
          browser.page.waitForSelector('[data-pairing-stage="paired"]', { timeout: 45_000 }).then(() => 'paired'),
          browser.page
            .waitForSelector('[data-pairing-stage]', { state: 'detached', timeout: 45_000 })
            .then(() => 'unmounted'),
        ]).catch(() => 'stuck');

        if (sinkhole.attempts() <= directBefore) {
          ledger.fail(
            'browser-tried-direct',
            'the browser never opened a connection to the advertised direct address, so a relayed success would prove nothing about fallback',
          );
        }
        ledger.prove(
          'browser-tried-direct',
          `Chrome opened ${String(sinkhole.attempts() - directBefore)} connection(s) to ${sinkhole.origin} and none answered`,
        );

        if (paired === 'stuck') {
          // Still on the pairing frame after 45 seconds. `failed` and a frozen `pairing` are
          // different defects, and the URL plus the surviving attributes separate them at a glance.
          const failure = await attributeNow(browser.page, '[data-pairing-stage]', 'data-pairing-failure');
          const where = await browser.page.evaluate<string>('location.href');
          ledger.fail(
            'browser-paired-over-relay',
            `the pairing screen reported ${String(await attributeNow(browser.page, '[data-pairing-stage]', 'data-pairing-stage'))}` +
              ` (failure=${String(failure)}) after pressing ${String(pressed)}, at ${where}.` +
              ` The page now renders: ${await renderedDataAttributes(browser.page)}.` +
              ` Page errors: ${browser.pageErrors.join(' | ') || 'none'}`,
          );
        }

        /**
         * THE CLAIM THIS STEP EXISTS FOR: the pairing crossed THIS relay.
         *
         * Asserted, not merely reported. A browser that somehow reached the daemon another way
         * would satisfy every screen assertion above and none of this one — and since the direct
         * address is a sinkhole, a client arrival at the rendezvous is the only route left.
         */
        const clientArrivals = (await rendezvous.arrivals()).filter(
          entry => entry.role === 'client' && entry.daemonId === fingerprint,
        );
        if (clientArrivals.length === 0) {
          ledger.fail(
            'browser-paired-over-relay',
            `the screen settled (${paired}) but no client ever arrived at the rendezvous for ${fingerprint}, so nothing crossed the relay`,
          );
        }
        ledger.prove(
          'browser-paired-over-relay',
          `the pairing screen settled (${paired}) and the rendezvous carried ${String(clientArrivals.length)} client session(s) for ${fingerprint}`,
        );

        /**
         * Both ends recorded the pairing, and neither assertion reads a credential.
         *
         * The browser side is `fy-has-pairings-v1`, a deliberately content-free mirror of "the
         * registry is non-empty" that exists so a surface can know a pairing happened without
         * touching a token. The daemon side is its own device list, which returns names and never a
         * token or a digest — and it is what makes the leak search below meaningful: it establishes
         * that `Ferretry PWA` is the name that actually crossed, so asserting its absence from the
         * relay's frames is a claim about a value the exchange really carried.
         */
        const persisted = await browser.page.evaluate<string | null>("localStorage.getItem('fy-has-pairings-v1')");
        if (persisted !== '1') ledger.fail('pairing-persisted', `fy-has-pairings-v1 is ${String(persisted)}, not "1"`);

        const token = (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
        const listed = await fetch(environment.httpUrl(PAIRED_DEVICES_PATH), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const devices = JSON.stringify(await listed.json());
        if (!devices.includes(PAIRED_DEVICE_NAME)) {
          ledger.fail(
            'pairing-persisted',
            `the daemon lists no device named ${PAIRED_DEVICE_NAME} after a successful pairing: ${devices.slice(0, 400)}`,
          );
        }
        ledger.prove(
          'pairing-persisted',
          `localStorage fy-has-pairings-v1 === "1" and the daemon recorded a device named ${PAIRED_DEVICE_NAME}, with no credential read on either side`,
        );

        /**
         * A SECOND session, opened with the grant the first one issued.
         *
         * The proof is the rendezvous' own arrival record rather than anything the app says about
         * itself, and that is the stronger direction: a §14 pairing session is one attempt and the
         * daemon closes it immediately, so a later client arrival cannot be the pairing exchange —
         * it is the ordinary authenticated path. Direct is a sinkhole, so there is no other route it
         * could have taken. The browser's own `data-carrier-kind` is a required second observation:
         * an absent attribute means the active-carrier surface never mounted, and anything other than
         * `relay` contradicts the rendezvous record.
         */
        const pairingArrivals = clientArrivals.length;
        await browser.page.goto(`${origin.origin}/d/${fingerprint}/session/${session.sessionId}`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        const authArrivals = await waitForClientArrivals(rendezvous, fingerprint, pairingArrivals + 1).catch(
          () => pairingArrivals,
        );
        if (authArrivals <= pairingArrivals) {
          ledger.fail(
            'authenticated-relay-session',
            `the rendezvous saw ${String(authArrivals)} client session(s) for ${fingerprint} — no second session followed the pairing, so nothing authenticated crossed the relay`,
          );
        }
        // `none` is "no walk has measured a carrier yet", deliberately not `direct` — so it is a
        // state to wait out, never an answer to assert against.
        const relayedCarrierMounted = await browser.page
          .waitForSelector('[data-carrier-kind="relay"]', { timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        if (!relayedCarrierMounted) {
          const carrier = await attributeNow(browser.page, '[data-carrier-kind]', 'data-carrier-kind');
          const carrierPage = await browser.page.evaluate<string>('location.href');
          ledger.fail(
            'authenticated-relay-session',
            `the browser's measured active carrier ${carrier === null ? 'has no data-carrier-kind attribute' : `reads ${carrier}`}, ` +
              `contradicting the relay's own record of ${String(authArrivals)} client session(s). ` +
              `Chrome is at ${carrierPage} and renders: ${await renderedDataAttributes(browser.page)}. ` +
              `Page errors: ${browser.pageErrors.join(' | ') || 'none'}`,
          );
        }
        ledger.prove(
          'authenticated-relay-session',
          `the rendezvous carried ${String(authArrivals)} client session(s) for this daemon — a second one after the pairing closed; the browser agrees with data-carrier-kind="relay"`,
        );

        /**
         * The three credentials that HAVE crossed, searched across every frame the rendezvous saw.
         *
         * Run here rather than at the end, deliberately. Every value in this search has already
         * gone over the wire, so the privacy claim about the pairing exchange is provable now
         * instead of waiting behind an unbuilt stream — and a claim deferred is a claim nobody has
         * checked. The event payload gets the identical treatment inside the stream step below,
         * where the value it names actually exists; asserting the absence of a marker no event ever
         * carried would be a check that passes because it tests nothing.
         *
         * The token is read out of the browser for this comparison and for nothing else, and
         * `plaintextLeaks` reports only which LABEL matched — never the value.
         */
        const stored = await deviceTokenForLeakSearchOnly(browser.page);
        if (stored.token === '') {
          ledger.fail(
            'relay-read-nothing',
            `no device token is stored, so the token leak search would assert nothing. The browser holds: ${stored.shape}`,
          );
        }
        const leaks = plaintextLeaks(await rendezvous.observations(), {
          'the pairing code': code,
          'the minted device token': stored.token,
          'the device name the browser sent': PAIRED_DEVICE_NAME,
        });
        if (leaks.length !== 0) ledger.fail('relay-read-nothing', leaks.join('; '));
        ledger.prove(
          'relay-read-nothing',
          `the pairing code, the minted device token and the device name ${PAIRED_DEVICE_NAME} are absent from all ` +
            `${String((await rendezvous.observations()).length)} frames the rendezvous handled`,
        );

        /**
         * A live event, and the browser watching for it over the relay.
         *
         * The cursor starts at `0` and only ever climbs, so "an event arrived" is `> 0` rather than
         * "different from before" — a value that changed could be a remount, and a value that grew
         * cannot be. The trigger is the waiting-then-working signal pair, which appends exactly two
         * durable journal events and leaves the session where it started; ORDER IS LOAD-BEARING,
         * because `working` on a session that is not parked appends nothing at all.
         *
         * The cursor itself has no received-event trace, only its monotonic maximum sequence. The
         * daemon's durable replay is therefore the authority for WHICH two events the signals
         * appended; after each successful response, this journey proves the next journal entry's
         * sequence and kind, then requires Chrome to reach that exact sequence. Waiting for the
         * first sequence before sending `working` prevents a later cursor jump from standing in for
         * the marked `waiting` event.
         */
        await browser.page.goto(`${origin.origin}/d/${fingerprint}/session/${session.sessionId}`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        const mounted = await browser.page
          .waitForSelector('[data-live-events]', { timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        if (!mounted) {
          ledger.fail(
            'live-stream-rendered',
            `the session route rendered no data-live-events for ${session.sessionId}. ` +
              `The page renders: ${await renderedDataAttributes(browser.page)}. ` +
              `Page errors: ${browser.pageErrors.join(' | ') || 'none'}`,
          );
        }
        const before = Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events'));
        const durableBefore = await sessionEvents(environment, session.sessionId, 0);
        const beforeSequence = durableBefore.at(-1)?.sequence ?? 0;
        const parked = await signalSession(environment, session.sessionId, 'waiting', eventMarker);
        if (!parked.ok) {
          ledger.fail(
            'live-stream-rendered',
            `the marked waiting signal failed with HTTP ${String(parked.status)}; no event attribution can follow`,
          );
        }
        if (parked.session?.state.status !== 'waiting' || !parked.session.state.reason?.includes(eventMarker)) {
          ledger.fail(
            'live-stream-rendered',
            `the successful waiting signal did not durably report the marker ${eventMarker}: ` +
              `status=${parked.session?.state.status ?? 'absent'}, reason=${parked.session?.state.reason ?? 'absent'}`,
          );
        }
        const waitingAppends = await sessionEvents(environment, session.sessionId, beforeSequence);
        const waitingEvent = waitingAppends[0];
        if (
          waitingAppends.length !== 1 ||
          waitingEvent === undefined ||
          waitingEvent.sequence !== beforeSequence + 1 ||
          waitingEvent.sessionId !== session.sessionId ||
          waitingEvent.type !== 'session.waiting'
        ) {
          ledger.fail(
            'live-stream-rendered',
            `the marked waiting signal did not append exactly session.waiting at sequence ${String(beforeSequence + 1)}: ` +
              `${JSON.stringify(waitingAppends.map(event => ({ sequence: event.sequence, sessionId: event.sessionId, type: event.type })))}`,
          );
        }
        const reachedWaiting = await browser.page
          .waitForSelector(liveCursorAtLeast(waitingEvent.sequence), { timeout: 30_000 })
          .then(async () => Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events')))
          .catch(async () => Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events')));
        if (reachedWaiting < waitingEvent.sequence) {
          ledger.fail(
            'live-stream-rendered',
            `Chrome did not reach the marked waiting event's exact durable sequence ${String(waitingEvent.sequence)}: ` +
              `data-live-events reached ${String(reachedWaiting)} from ${String(before)}. ` +
              `The successful waiting response recorded ${eventMarker}, and the daemon replay named session.waiting at that sequence.`,
          );
        }

        const resumed = await signalSession(environment, session.sessionId, 'working', eventMarker);
        if (!resumed.ok) {
          ledger.fail(
            'live-stream-rendered',
            `the working signal matching marked waiting event ${String(waitingEvent.sequence)} failed with HTTP ${String(resumed.status)}`,
          );
        }
        const workingAppends = await sessionEvents(environment, session.sessionId, waitingEvent.sequence);
        const workingEvent = workingAppends[0];
        if (
          workingAppends.length !== 1 ||
          workingEvent === undefined ||
          workingEvent.sequence !== waitingEvent.sequence + 1 ||
          workingEvent.sessionId !== session.sessionId ||
          workingEvent.type !== 'session.waiting_cleared'
        ) {
          ledger.fail(
            'live-stream-rendered',
            `the successful working signal did not append exactly session.waiting_cleared after marked waiting sequence ${String(waitingEvent.sequence)}: ` +
              `${JSON.stringify(workingAppends.map(event => ({ sequence: event.sequence, sessionId: event.sessionId, type: event.type })))}`,
          );
        }
        // Reach the exact latter sequence (or a later one if an unrelated event arrived afterwards), never `before + 2`.
        const advanced = await browser.page
          .waitForSelector(liveCursorAtLeast(workingEvent.sequence), { timeout: 30_000 })
          .then(async () => Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events')))
          .catch(async () => Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events')));
        if (advanced < workingEvent.sequence) {
          /**
           * The discriminator: did the browser OPEN a stream session at all?
           *
           * §14 gives every live stream its own authenticated session, so a subscription shows up
           * at the rendezvous as another client arrival. More arrivals than the pairing plus the
           * request session means the browser dialled and the frames did not come; the same count
           * means it never subscribed. Those are different defects in different packages, and
           * without this number the report cannot tell them apart.
           */
          const streams = (await rendezvous.arrivals()).filter(
            entry => entry.role === 'client' && entry.daemonId === fingerprint,
          ).length;
          ledger.fail(
            'live-stream-rendered',
            `the browser did not reach the working event's exact durable sequence ${String(workingEvent.sequence)}: ` +
              `data-live-events reached ${String(advanced)} (delta ${String(advanced - before)}), starting from ${String(before)}. ` +
              `The signal pair succeeded with HTTP ${String(parked.status)} then ${String(resumed.status)}; daemon replay established ` +
              `marked session.waiting at ${String(waitingEvent.sequence)} followed by session.waiting_cleared at ${String(workingEvent.sequence)}. ` +
              `The rendezvous saw ${String(streams)} client session(s) in total (${String(pairingArrivals)} for pairing, ` +
              `${String(authArrivals - pairingArrivals)} for the authenticated request session) — ` +
              `${streams > authArrivals ? 'a stream session WAS opened' : 'NO stream session was ever opened'}. ` +
              `Console: ${browser.console.slice(-6).join(' | ') || 'silent'}`,
          );
        }
        const payloadLeaks = plaintextLeaks(await rendezvous.observations(), {
          'the live event payload marker': eventMarker,
        });
        if (payloadLeaks.length !== 0) ledger.fail('live-stream-rendered', payloadLeaks.join('; '));
        ledger.prove(
          'live-stream-rendered',
          `the successful marked waiting response recorded ${eventMarker}; daemon replay then established session.waiting ` +
            `at sequence ${String(waitingEvent.sequence)} followed by session.waiting_cleared at ${String(workingEvent.sequence)}. ` +
            `Chrome reached those sequences in order, ending at ${String(advanced)} (delta ${String(advanced - before)}; ` +
            `at least ${String(workingEvent.sequence - before)} needed to reach the latter sequence), and that marker appears in no relay-observable frame`,
        );

        /**
         * THE DAEMON GOES AWAY, AND THE PAGE HAS TO STOP CLAIMING TO BE LIVE.
         *
         * Everything above this line passed before the reconnect work existed AND after the socket
         * had died — that is precisely the defect. The transcript kept refreshing on its poll, the
         * session stayed connected, the carrier stayed relayed, and a page whose live feed had ended
         * twenty minutes earlier was indistinguishable from one that was merely quiet. Nothing a
         * browser rendered could tell the two apart, so nothing a JOURNEY asserted could either.
         *
         * Stopping the compiled daemon is the honest version of that event: the rendezvous loses its
         * daemon socket, the browser's §14 stream session ends, and no amount of polling brings the
         * feed back. What is asserted is what a reader would see.
         */
        const liveStreamNow = async (): Promise<string> =>
          String(await attributeNow(browser.page, '[data-live-stream]', 'data-live-stream'));
        if ((await liveStreamNow()) !== 'live') {
          ledger.fail(
            'lost-stream-is-visible',
            `the page did not read as live before the daemon was stopped: data-live-stream=${await liveStreamNow()}. ` +
              `The page renders: ${await renderedDataAttributes(browser.page)}`,
          );
        }
        const cursorWhileLive = Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events'));

        await environment.stopDaemon();
        /**
         * `reconnecting` EXACTLY, and `disconnected` would be the wrong success.
         *
         * The two are not interchangeable outcomes of one event. `reconnecting` is a schedule that is
         * still running; `disconnected` is the budget exhausted, and it deliberately does NOT recover
         * on its own — the reader's control is the way back from it, by design. Accepting either here
         * would let the step below claim an automatic recovery from a state that cannot have one, and
         * whether the outage happened to outlast the budget is a fact about how fast this machine
         * restarts a daemon rather than about the product.
         *
         * The close should arrive at once: the rendezvous drops the daemon socket when the process
         * goes, so the browser's stream session ends rather than waiting out the silence watchdog.
         */
        const lost = await browser.page
          .waitForSelector('[data-live-stream="reconnecting"]', { timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        const lostState = await liveStreamNow();
        if (!lost) {
          ledger.fail(
            'lost-stream-is-visible',
            `Chrome reads data-live-stream=${lostState} 60s after the compiled daemon was stopped, and this step ` +
              `needs "reconnecting". "live" is the defect this journey exists for; "disconnected" would mean the ` +
              `retry budget ran out during the outage, which no longer proves the automatic recovery below. ` +
              `Console: ${browser.console.slice(-6).join(' | ') || 'silent'}`,
          );
        }
        ledger.prove(
          'lost-stream-is-visible',
          `with the compiled daemon stopped, Chrome left "live" for data-live-stream=${lostState} on screen, ` +
            `holding the cursor it had already reached (${String(cursorWhileLive)}) rather than rewinding it`,
        );

        /**
         * AND IT COMES BACK BY ITSELF.
         *
         * The manual control is proved in the unit tier, where a click is a click; what only a real
         * browser can show is that the SCHEDULE actually runs in one — that a page nobody touched
         * picks a returning daemon back up. So nothing is clicked here.
         *
         * A reopened socket is not a recovered feed, which is why the assertion is an EVENT and not
         * a state: the daemon proves a quiet stream only every thirty seconds, so a page that
         * reconnected and then sat unproved would be indistinguishable from one that never did.
         *
         * WHAT THIS CANNOT SEE, said out loud: the relay carries sealed records, so no observer here
         * — this journey included — can read the `after` cursor the resumed subscription actually put
         * on the wire. What it proves is narrower and is still the thing a reader cares about: THIS
         * page, never reloaded, resumed delivery and its cursor moved forward from the value it held
         * before the outage. That a reconnection sends the cursor it reached rather than zero is
         * proved where it can be read directly, in `session-event-stream-model.test.ts`.
         */
        await environment.startDaemon({
          command: [compiledDaemon(), '--config', configPath],
          readyUrl: environment.httpUrl('/v1/health'),
          timeoutMs: 30_000,
          env: { FY_RELAY_DIRECTORY_ORIGIN: directory.origin },
        });
        await waitForDaemonAtRendezvous(rendezvous);

        /**
         * The post-restart baseline, read BEFORE the signal rather than assumed.
         *
         * A boot is allowed to append to a session's journal, so "the newest event after the outage"
         * is not the same claim as "the event this signal caused" — taking the last row would let
         * unrelated startup activity stand in for the recovery, and the step would pass on a browser
         * that recovered nothing. Measuring here makes the attribution below exact in the same way
         * the first pair's is: one event, at a named sequence, of a named kind, carrying the marker.
         */
        const afterRestart = await sessionEvents(environment, session.sessionId, workingEvent.sequence);
        const restartBaseline = afterRestart.at(-1)?.sequence ?? workingEvent.sequence;

        const recoveredMarker = `${eventMarker}-again`;
        const parkedAgain = await signalSession(environment, session.sessionId, 'waiting', recoveredMarker);
        if (!parkedAgain.ok) {
          ledger.fail(
            'live-stream-recovers',
            `the restarted daemon refused the second waiting signal with HTTP ${String(parkedAgain.status)}`,
          );
        }
        if (
          parkedAgain.session?.state.status !== 'waiting' ||
          !parkedAgain.session.state.reason?.includes(recoveredMarker)
        ) {
          ledger.fail(
            'live-stream-recovers',
            `the second waiting signal did not durably report the marker ${recoveredMarker}: ` +
              `status=${parkedAgain.session?.state.status ?? 'absent'}, reason=${parkedAgain.session?.state.reason ?? 'absent'}`,
          );
        }
        const recoveredAppends = await sessionEvents(environment, session.sessionId, restartBaseline);
        const recoveredEvent = recoveredAppends[0];
        if (
          recoveredAppends.length !== 1 ||
          recoveredEvent === undefined ||
          recoveredEvent.sequence !== restartBaseline + 1 ||
          recoveredEvent.sessionId !== session.sessionId ||
          recoveredEvent.type !== 'session.waiting'
        ) {
          ledger.fail(
            'live-stream-recovers',
            `the second waiting signal did not append exactly session.waiting at sequence ${String(restartBaseline + 1)}: ` +
              `${JSON.stringify(recoveredAppends.map(entry => ({ sequence: entry.sequence, sessionId: entry.sessionId, type: entry.type })))}`,
          );
        }
        const recoveredCursor = await browser.page
          .waitForSelector(liveCursorAtLeast(recoveredEvent.sequence), { timeout: 120_000 })
          .then(async () => Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events')))
          .catch(async () => Number(await attributeNow(browser.page, '[data-live-events]', 'data-live-events')));
        const recoveredState = await liveStreamNow();
        if (recoveredCursor < recoveredEvent.sequence) {
          ledger.fail(
            'live-stream-recovers',
            `after the daemon returned, Chrome reached data-live-events=${String(recoveredCursor)} and needed ` +
              `${String(recoveredEvent.sequence)}; it reads data-live-stream=${recoveredState}. ` +
              `Nobody clicked anything, so this is the automatic schedule failing to pick the daemon back up. ` +
              `Console: ${browser.console.slice(-6).join(' | ') || 'silent'}`,
          );
        }
        if (recoveredState !== 'live') {
          ledger.fail(
            'live-stream-recovers',
            `a delivered event moved the cursor to ${String(recoveredCursor)} but the page still reads ` +
              `data-live-stream=${recoveredState}, so the visible state and the feed disagree`,
          );
        }
        ledger.prove(
          'live-stream-recovers',
          `with nothing clicked, the never-reloaded page reconnected to the restarted daemon by itself and returned to ` +
            `data-live-stream=live. The marked second waiting signal appended exactly session.waiting at sequence ` +
            `${String(recoveredEvent.sequence)}, and Chrome reached ${String(recoveredCursor)} — forward from the ` +
            `pre-outage cursor ${String(cursorWhileLive)} on the same page view. The sealed relay hides the wire ` +
            `\`after\` value from every observer including this one, so the exact resumption cursor is proved in the ` +
            `unit suite rather than claimed here`,
        );

        // A noted step does not abort, so the journey can reach here with one still unproven. It is
        // not green until every step is.
        const outstanding = ledger.firstUnproven();
        if (outstanding !== undefined) {
          throw new Error(`UNPROVEN ${outstanding.id} — ${outstanding.claim}`);
        }
      });
    } catch (error) {
      journeyError = error;
    } finally {
      await ledger.write(REPORT_PATH);
      await teardown.closeAll().catch(() => undefined);
    }
    if (journeyError !== undefined) await reportAndRethrow(journeyError, REPORT_PATH);
  }, 300_000);
});
