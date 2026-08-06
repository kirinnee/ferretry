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
 *        speaking real WebSockets (see `support/rendezvous-process.ts` for what Bun substitutes)
 *   REAL PWA bundle from `vite build`, served over HTTP under the published site's own CSP
 *   REAL Google Chrome, driven by `playwright-core`
 *   REAL failure of the direct address, arranged rather than assumed
 *
 * ── WHY THE SECOND TEST IS RED, AND WHY THAT IS THE POINT ──────────────────────────────────────
 *
 * Relay-mediated pairing and §14 stream sessions are SPECIFIED and NOT YET BUILT — the protocol
 * document says so in §13's "What is not built yet", and three implementation units are writing
 * them now. A harness for a journey that cannot complete has exactly two honest shapes: a test that
 * fails naming the first unproven step, or no test at all. A test that passed by asserting
 * something weaker would be the one outcome the owner explicitly ruled out, so this one fails, and
 * its failure message and its written report both name the first unproven step exactly.
 *
 * When the implementation lands it goes green with no edit to this file. Until then the first test
 * below guards every moving part of the harness itself, so the red one stays a statement about the
 * product rather than a statement about the scaffolding.
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
import {
  attributeNow,
  buildPwaBundle,
  chromeExecutable,
  clickFirstPresent,
  describeControls,
  deviceTokenForLeakSearchOnly,
  harnessTeardown,
  launchChrome,
  type LedgerStep,
  plaintextLeaks,
  renderedDataAttributes,
  startDirectSinkhole,
  startPwaOrigin,
  type RendezvousProcess,
  startRendezvous,
  stepLedger,
  type StepLedger,
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
  readonly relayUrl: string;
  readonly appOrigin: string;
}

function daemonDocument(input: DaemonDocument): string {
  return `${JSON.stringify(
    {
      publicUrl: input.publicUrl,
      // The app origin is a real origin here rather than the published site, so a direct attempt
      // fails at TRANSPORT against the sinkhole instead of being refused earlier by CORS — which
      // would prove a different thing, and a weaker one.
      corsOrigins: [input.appOrigin],
      carriers: [
        { kind: 'bind', host: '127.0.0.1', port: input.bindPort },
        { kind: 'relay', url: input.relayUrl },
        // "No, and I mean it." An omitted discovery entry is read as the hosted default; this is
        // the explicit spelling, so nothing in this journey can reach a real service.
        { kind: 'relay', source: 'discovery', enabled: false },
      ],
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
  '[data-pair-confirm]',
  // "Pair this device" — `pairing-screen.tsx`'s confirm action, which carries the design system's
  // `primary` variant and no test attribute of its own yet.
  '[data-pairing-stage="confirm"] button[data-variant="primary"]',
  '[data-pairing-stage="confirm"] button[type="submit"]',
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
 * The daemon-side command that must produce a live event.
 *
 * Overridable because nobody in this unit owns the answer yet: the event feed is fed from session
 * journal events, and starting a session needs a published fleet account this isolated home does
 * not have. `attention raise` is the cheapest candidate that carries a payload the leak search can
 * look for; `FY_E2E_EVENT_TRIGGER` (space-separated `fy` arguments, `{marker}` interpolated) is how
 * you swap it without editing this file when the real answer is known.
 */
function eventTrigger(marker: string): readonly string[] {
  const configured = process.env.FY_E2E_EVENT_TRIGGER;
  if (configured !== undefined && configured.trim() !== '') {
    return configured
      .trim()
      .split(/\s+/u)
      .map(argument => argument.replaceAll('{marker}', marker));
  }
  return ['attention', 'raise', marker];
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
  { id: 'pairing-link-names-relay', claim: 'the minted link is v2 and its relay= is this run’s rendezvous' },
  { id: 'browser-tried-direct', claim: 'the browser attempted the advertised direct address and it failed' },
  {
    id: 'browser-paired-over-relay',
    claim: 'the pairing screen reports paired, and the rendezvous carried a client session',
  },
  {
    id: 'pairing-persisted',
    claim: 'both ends recorded the pairing, and the daemon names the device, without reading a credential',
  },
  { id: 'authenticated-relay-session', claim: 'the session that followed pairing won on the relay carrier' },
  { id: 'live-stream-rendered', claim: 'a real daemon event reached Chrome and changed the product' },
  { id: 'relay-read-nothing', claim: 'no code, token, device name or payload appears in any relay-observable frame' },
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
): Promise<string> {
  const before = await rendezvous.dialled();
  await environment.startDaemon({
    command: [compiledDaemon(), '--config', configPath],
    readyUrl: environment.httpUrl('/v1/health'),
    timeoutMs: 30_000,
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
        const sinkhole = await startDirectSinkhole(teardown);
        const configPath = join(environment.paths.root, 'daemon.json');

        // Act — the rendezvous, the compiled daemon, the sinkhole, the bundle and Chrome, in turn.
        const stranger = await fetch(`${rendezvous.httpOrigin}/v1/rendezvous/fy_daemon_${'A'.repeat(43)}/daemon`, {
          headers: { Upgrade: 'websocket' },
        });

        await writeFile(
          configPath,
          daemonDocument({
            bindPort: environment.ports.api,
            publicUrl: sinkhole.origin,
            relayUrl: rendezvous.relayUrl,
            appOrigin: 'http://127.0.0.1:1',
          }),
          'utf8',
        );
        const fingerprint = await bootAndLearnFingerprint(environment, configPath, rendezvous);
        await rendezvous.allow(fingerprint);
        await environment.startDaemon({
          command: [compiledDaemon(), '--config', configPath],
          readyUrl: environment.httpUrl('/v1/health'),
          timeoutMs: 30_000,
        });
        await waitForDaemonAtRendezvous(rendezvous);

        const directFailure = await fetch(`${sinkhole.origin}/v1/health`).then(
          () => undefined,
          (error: unknown) => error,
        );

        const distDir = await buildPwaBundle();
        const origin = await startPwaOrigin(distDir, teardown);
        const browser = await launchChrome(teardown);
        await browser.page.goto(`${origin.origin}/pair`, { waitUntil: 'networkidle', timeout: 30_000 });
        const title = await browser.page.evaluate<string>('document.title');
        const rendered = await browser.page.evaluate<number>('document.body.innerText.trim().length');

        // Assert
        should(stranger.status).equal(404);
        should(fingerprint).match(FINGERPRINT);
        should((await rendezvous.sockets()).some(row => row.roles.includes('daemon'))).be.true();
        should(directFailure).be.an.Error();
        should(sinkhole.attempts()).be.greaterThan(0);
        should(chromeExecutable()).not.be.empty();
        should(title).not.be.empty();
        should(rendered).be.greaterThan(0);
        should(origin.missingAssets()).be.empty();
        should(browser.pageErrors).be.empty();
        should((await rendezvous.observations()).length).be.greaterThan(0);
      });
    } finally {
      await teardown.closeAll();
    }
  }, 240_000);

  it('should carry a first pairing and a live stream over the relay (RED until §14 ships — the failure names the first unproven step)', async () => {
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

        const sinkhole = await startDirectSinkhole(teardown);
        const distDir = await buildPwaBundle();
        const origin = await startPwaOrigin(distDir, teardown);
        const configPath = join(environment.paths.root, 'daemon.json');
        await writeFile(
          configPath,
          daemonDocument({
            bindPort: environment.ports.api,
            publicUrl: sinkhole.origin,
            relayUrl: rendezvous.relayUrl,
            appOrigin: origin.origin,
          }),
          'utf8',
        );

        const fingerprint = await bootAndLearnFingerprint(environment, configPath, rendezvous).catch((error: unknown) =>
          ledger.fail('daemon-fingerprint', String(error)),
        );
        ledger.prove('daemon-fingerprint', `the compiled daemon minted ${fingerprint}`);

        await rendezvous.allow(fingerprint);
        await environment.startDaemon({
          command: [daemonBin, '--config', configPath],
          readyUrl: environment.httpUrl('/v1/health'),
          timeoutMs: 30_000,
        });
        await waitForDaemonAtRendezvous(rendezvous).catch((error: unknown) =>
          ledger.fail('daemon-claims-rendezvous', String(error)),
        );
        ledger.prove('daemon-claims-rendezvous', `the rendezvous holds a daemon socket for ${fingerprint}`);

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
         * keeps the host-rendered screen on the critical path — which is where a v1-only fragment
         * reader was caught, in a build where every other half was already correct.
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
         * The browser reads the link BEFORE the link is asserted to be v2, deliberately.
         *
         * A v1 fragment is a perfectly good arrival for the confirm stage — the reader is being
         * asked which machine they are pairing with, and that question does not depend on which
         * carrier the answer will take. Checking the app first means a screen defect and a mint
         * defect cannot hide behind one another, and each unit sees its own gap named.
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

        if (!fragment.startsWith('v2;')) {
          ledger.fail(
            'pairing-link-names-relay',
            `the daemon minted a ${fragment.split(';')[0] ?? '?'} link. §14 relayed pairing needs a v2 fragment carrying relay=; ` +
              'until the daemon emits one, a browser that cannot reach the direct address has no rendezvous to dial.',
          );
        }
        if (relayField !== rendezvous.relayUrl) {
          ledger.fail(
            'pairing-link-names-relay',
            `the v2 fragment names relay=${String(relayField)}, not this run's rendezvous ${rendezvous.relayUrl}`,
          );
        }
        if (!advertised.startsWith(sinkhole.origin)) {
          ledger.fail(
            'pairing-link-names-relay',
            `the fragment advertises ${advertised}, not the unreachable ${sinkhole.origin}`,
          );
        }
        ledger.prove(
          'pairing-link-names-relay',
          `v2 fragment advertising ${advertised} and naming ${String(relayField)}`,
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

        await browser.page.goto(`${origin.origin}/app/#/settings/daemons`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        const carrier = await browser.page
          .waitForSelector('[data-carrier-kind="relay"]', { timeout: 30_000 })
          .then(() => 'relay')
          .catch(async () => String(await attributeNow(browser.page, '[data-carrier-kind]', 'data-carrier-kind')));
        if (carrier !== 'relay') {
          ledger.fail(
            'authenticated-relay-session',
            `the live carrier reads ${carrier}, so the authenticated session did not cross the relay`,
          );
        }
        ledger.prove('authenticated-relay-session', 'data-carrier-kind="relay" on the measured active carrier');

        const before = String(await attributeNow(browser.page, '[data-live-events]', 'data-live-events'));
        const trigger = await environment.runFy(eventTrigger(eventMarker), { FY_URL: environment.httpUrl() });
        const advanced = await browser.page
          .waitForSelector(`[data-live-events]:not([data-live-events="${before}"])`, { timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        if (!advanced) {
          ledger.fail(
            'live-stream-rendered',
            `no live event reached the browser after \`fy ${eventTrigger(eventMarker).join(' ')}\` ` +
              `(exit ${String(trigger.code)}${trigger.err === '' ? '' : `: ${trigger.err.trim()}`}); ` +
              `data-live-events did not advance from ${before}`,
          );
        }
        ledger.prove(
          'live-stream-rendered',
          `data-live-events advanced in Chrome after a real daemon event carrying ${eventMarker}`,
        );

        /**
         * All four secrets, searched across every frame the rendezvous handled.
         *
         * The token is read out of the browser for this comparison and for nothing else, and
         * `plaintextLeaks` reports only which label matched — never the value. The device name is
         * searchable because the harness made it unique through the user agent the app derives it
         * from, and the event payload is searchable for the same reason: a marker nobody else on
         * this host could have produced.
         */
        const deviceToken = await deviceTokenForLeakSearchOnly(browser.page);
        if (deviceToken === '') {
          ledger.fail('relay-read-nothing', 'no device token is stored, so the token leak search would assert nothing');
        }
        const leaks = plaintextLeaks(await rendezvous.observations(), {
          'the pairing code': code,
          'the minted device token': deviceToken,
          'the device name the browser sent': PAIRED_DEVICE_NAME,
          'the live event payload marker': eventMarker,
        });
        if (leaks.length !== 0) ledger.fail('relay-read-nothing', leaks.join('; '));
        ledger.prove(
          'relay-read-nothing',
          'the pairing code, the minted device token, the device name and the live event payload are all absent from every relay-observable frame',
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
