import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';
import {
  addVirtualAuthenticator,
  type VirtualAuthenticator,
  adminToken,
  OPERATOR_PASSWORD,
  answerPasswordIfAsked,
  asOwner,
  bootDaemon,
  type BootOptions,
  captureScreens,
  EVIDENCE_ROOT,
  confirmPairing,
  currentRoute,
  ensureOperatorPassword,
  type FakeTools,
  fakeToolEnvironment,
  installFakeTools,
  launchProductBrowser,
  mintPairingLink,
  type ProductBrowser,
  type ProductPage,
  reapLeftovers,
  recordStep,
  softStep,
  assertNoSoftFailures,
  step,
  textNow,
  waitUntil,
  writeDaemonConfig,
} from './support/product-harness.ts';
import {
  buildPwaBundle,
  deviceGrantForLeakSearchOnly,
  harnessTeardown,
  type HarnessTeardown,
  type PwaOrigin,
  renderedDataAttributes,
  startPwaOrigin,
  startRelayDirectory,
  startRendezvous,
  startDirectSinkhole,
  type DirectSinkhole,
  type RendezvousProcess,
  waitForDaemonAtRendezvous,
  waitForDaemonFingerprint,
  plaintextLeaks,
} from './support/relay-harness.ts';

/**
 * THE PRODUCT, AS A PERSON MEETS IT: a fresh machine, a browser paired to it, the machine set up from
 * the browser, an agent started and talked to, a terminal, a secret and a setting.
 *
 * Every other journey in this tier proves one seam. This one walks the order a new owner actually
 * walks, against the compiled `fyd`, the real bundle and a real Chrome, with fake `claude`/`codex`
 * binaries standing in for the harnesses (`scripts/test/fake-claude-tui.sh`,
 * `scripts/test/fake-codex-login.ts`) — so nothing reaches a real account, a real home or anything
 * beyond loopback. Each step is written to the journey log (`support/product-harness.ts`) with its
 * evidence, and every screen it reaches is captured at phone and desktop width, light and dark, with
 * the margins measured.
 *
 * Steps that need the unlock model (#464: passkeys, unlock, per-device grants) feature-detect it. On
 * a build without it they record SKIP with the reason, rather than pass by testing nothing.
 */

interface Product {
  readonly environment: E2eEnvironment;
  readonly teardown: HarnessTeardown;
  readonly origin: PwaOrigin;
  readonly tools: FakeTools;
  readonly browser: ProductBrowser;
  /** How this machine was booted, so a journey can stop and boot it again. */
  readonly boot: BootOptions;
  /** Present when the direct address is a sinkhole and the only way in is the local rendezvous. */
  readonly relay?: {
    readonly rendezvous: RendezvousProcess;
    readonly sinkhole: DirectSinkhole;
    readonly fingerprint: string;
  };
}

interface ProductOptions {
  /** Block the direct carrier and carry everything over a local rendezvous (journey 6). */
  readonly relay?: boolean;
}

/** Boot one machine and one browser, unpaired. Every journey starts here. */
async function withProduct(
  journey: string,
  body: (product: Product) => Promise<void>,
  options: ProductOptions = {},
): Promise<void> {
  const teardown = harnessTeardown();
  try {
    await withE2eEnvironment(async environment => {
      const directory = await startRelayDirectory();
      const rendezvous = options.relay === true ? await startRendezvous(environment.paths.root, teardown) : undefined;
      const sinkhole = options.relay === true ? await startDirectSinkhole(teardown) : undefined;
      // Direct journeys publish "no rendezvous", so nothing can be carried by a relay by accident.
      // The relay journey publishes this run's rendezvous, which BOTH ends then discover.
      directory.publish(rendezvous?.relayUrl ?? null);
      const distDir = await buildPwaBundle(directory.origin);
      const served = await startPwaOrigin(distDir, teardown);
      /**
       * The app is opened at `localhost`, never `127.0.0.1`: a WebAuthn relying-party id must be a
       * domain, so Chrome refuses every passkey ceremony on an IP-address origin ("The browser refused a
       * passkey at http://127.0.0.1:…"). `localhost` is a secure context and a legal RP id, and still
       * loopback.
       */
      const origin: PwaOrigin = { ...served, origin: served.origin.replace('//127.0.0.1:', '//localhost:') };
      const tools = await installFakeTools(environment);
      const configPath = await writeDaemonConfig(join(environment.paths.root, 'daemon.json'), {
        bindPort: environment.ports.api,
        appOrigins: [origin.origin],
        // The advertised direct address is the sinkhole: a browser that uses it fails at transport.
        ...(sinkhole === undefined ? {} : { publicUrl: sinkhole.origin }),
      });
      const boot = { configPath, directoryOrigin: directory.origin, env: fakeToolEnvironment(tools) };
      let fingerprint = '';
      if (rendezvous !== undefined) {
        // First boot mints the identity and dials; the rendezvous refuses it until it is listed.
        const seen = await rendezvous.dialled();
        await bootDaemon(environment, boot);
        fingerprint = await waitForDaemonFingerprint(rendezvous, seen);
        await environment.stopDaemon();
        await rendezvous.allow(fingerprint);
      }
      await bootDaemon(environment, boot);
      if (rendezvous !== undefined) await waitForDaemonAtRendezvous(rendezvous);
      let browser = await launchProductBrowser(teardown);
      /**
       * An intermittent HARNESS failure, seen twice in ~20 journeys: the first navigation of a freshly
       * launched Chrome reports "Target page, context or browser has been closed". It never reproduced
       * in isolation, so a fresh browser is probed once and relaunched if it is already dead — and the
       * event is recorded, so it stays visible instead of being retried away silently.
       */
      const alive = await browser.page.goto(`${origin.origin}/`, { waitUntil: 'load', timeout: 15_000 }).then(
        () => true,
        () => false,
      );
      if (!alive) {
        await recordStep({
          journey,
          step: 'harness:chrome-relaunched',
          status: 'FLAG',
          evidence: 'a freshly launched Chrome was already closed at its first navigation; relaunched once',
        });
        browser = await launchProductBrowser(teardown);
      }
      await recordStep({
        journey,
        step: 'boot',
        status: 'PASS',
        evidence: `fyd on ${environment.httpUrl()}, app ${origin.origin}${rendezvous === undefined ? '' : `, direct advertised as the sinkhole ${sinkhole?.origin ?? ''}, rendezvous ${rendezvous.relayUrl}`}`,
      });
      try {
        await body({
          environment,
          teardown,
          origin,
          tools,
          browser,
          boot,
          ...(rendezvous === undefined || sinkhole === undefined
            ? {}
            : { relay: { rendezvous, sinkhole, fingerprint } }),
        });
        should(browser.pageErrors).be.empty();
        should(origin.missingAssets()).be.empty();
      } finally {
        // Before the fixture removes the root: its tmux socket and its paths are how leftovers are found.
        await environment.stopDaemon();
        await reapLeftovers(environment, journey);
      }
    });
  } finally {
    await teardown.closeAll();
  }
}

/** Pair this browser; answers the daemon id the link pinned (`fp=`). */
async function pair(product: Product, journey: string): Promise<string> {
  const { environment, origin, browser } = product;
  const model = await ensureOperatorPassword(environment);
  const link = await step(journey, 'mint-pairing-link', async () => {
    const minted = await mintPairingLink(environment, origin.origin);
    return {
      value: minted,
      evidence: `fy pair --no-wait printed a ${minted.fragment.slice(0, 3)} link (password model: ${model})`,
    };
  });
  await browser.page.goto(link.url, { waitUntil: 'networkidle', timeout: 30_000 });
  await browser.page.waitForSelector('[data-pairing-stage="confirm"]', { timeout: 20_000 });
  await captureScreens(browser.page, journey, '01-pair-confirm');
  await step(journey, 'pair', async () => {
    const settled = await confirmPairing(browser.page, link.url);
    return { value: settled, evidence: `the pairing screen settled: ${settled}` };
  });
  const fingerprint = /(?:^|;)fp=([^;]+)/u.exec(link.fragment)?.[1];
  if (fingerprint === undefined) throw new Error(`the pairing link pins no daemon: ${link.fragment.slice(0, 40)}`);
  return decodeURIComponent(fingerprint);
}

/** Wait for a selector, and on failure say what the page DID render. */
async function expectScreen(page: ProductPage, selector: string, timeout = 20_000): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch {
    throw new Error(
      `never saw ${selector} at ${page.url()} (route ${String(await currentRoute(page))}). ` +
        `Alerts: ${String(await textNow(page, '[role="alert"]'))}. Rendered: ${(await renderedDataAttributes(page as never)).slice(0, 1_200)}`,
    );
  }
}

/**
 * From the first run's opening to the Claude question, through whatever stands between.
 *
 * The scan gate (main's operator password) and the tools step each render only after a read, so
 * checking for either at one instant raced them. This waits for SOME known screen and answers it
 * until the Claude question is on the glass.
 */
async function reachClaudeQuestion(page: ProductPage, journey: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const at = await page.evaluate<string>(`(() => {
      if (document.querySelector('[data-machine-stepper][data-step="claude"] [data-harness-import]')) return 'claude';
      if (document.querySelector('[data-first-run-locked] [data-change-submit]')) return 'locked';
      if (document.querySelector('[data-machine-stepper][data-step="tools"] [data-step-next]')) return 'tools';
      return 'waiting';
    })()`);
    if (at === 'claude') return;
    if (at === 'locked') {
      await answerPasswordIfAsked(page);
      await page.click('[data-first-run-locked] [data-change-submit]');
      await page.waitForSelector('[data-first-run-locked]', { state: 'detached', timeout: 20_000 });
      await recordStep({
        journey,
        step: 'first-run-scan-gate',
        status: 'PASS',
        evidence: 'the scan asked for the operator password and read the machine once given it',
      });
    } else if (at === 'tools') await page.click('[data-machine-stepper][data-step="tools"] [data-step-next]');
    else await Bun.sleep(200);
  }
  throw new Error(
    `the first run never reached the Claude question: ${(await renderedDataAttributes(page as never)).slice(0, 800)}`,
  );
}

/** Whether this build has the unlock model (#464): its security settings route exists. */
async function hasUnlockModel(environment: E2eEnvironment): Promise<boolean> {
  return (await asOwner(environment, 'GET', '/v1/security')).status !== 404;
}

const authenticators = new WeakMap<ProductBrowser, VirtualAuthenticator>();

/** One CDP virtual authenticator per browser — a browser is one device with one platform authenticator. */
async function authenticatorFor(browser: ProductBrowser): Promise<VirtualAuthenticator> {
  const known = authenticators.get(browser);
  if (known !== undefined) return known;
  const made = await addVirtualAuthenticator(browser);
  authenticators.set(browser, made);
  // Every unlock or step-up prompt this tab ever shows is counted, across navigations, so "no further
  // prompts after the unlock" is a number rather than an impression.
  await browser.context.addInitScript(`(() => {
    const seen = new WeakSet();
    const count = () => {
      for (const node of document.querySelectorAll('[data-step-up-dialog]')) {
        if (seen.has(node)) continue;
        seen.add(node);
        try { sessionStorage.setItem('fy-e2e-prompts', String(Number(sessionStorage.getItem('fy-e2e-prompts') ?? '0') + 1)); } catch {}
      }
    };
    new MutationObserver(count).observe(document, { subtree: true, childList: true });
  })()`);
  return made;
}

async function promptsShown(page: ProductPage): Promise<number> {
  return page.evaluate<number>(`Number(sessionStorage.getItem('fy-e2e-prompts') ?? '0')`);
}

/** Answer the unlock prompt with the passkey, if it is on screen or appears within `waitMs`. */
async function unlockIfAsked(page: ProductPage, waitMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (
      await page.evaluate<boolean>(`document.querySelector('[data-step-up-dialog] [data-step-up-confirm]') !== null`)
    ) {
      await page.click('[data-step-up-dialog] [data-step-up-confirm]');
      await page.waitForSelector('[data-step-up-dialog]', { state: 'detached', timeout: 30_000 }).catch(async () => {
        throw new Error(`the unlock prompt did not close: ${String(await textNow(page, '[data-step-up-dialog]'))}`);
      });
      return true;
    }
    await Bun.sleep(200);
  }
  return false;
}

/**
 * Journeys 2 and 3 under the unlock model: register a passkey with the virtual authenticator, see the
 * machine refuse until it is unlocked, unlock it once, and from then on meet no prompt at all.
 *
 * On a build without the model (main before #464) this records SKIP and returns.
 */
async function registerPasskeyAndUnlock(product: Product, daemonId: string, journey: string): Promise<void> {
  const { environment, browser, origin } = product;
  const page = browser.page;
  if (!(await hasUnlockModel(environment))) {
    await recordStep({
      journey,
      step: 'passkey-unlock',
      status: 'SKIP',
      evidence: 'this build has no /v1/security — the unlock model (#464) is not merged',
    });
    return;
  }
  // Installed before the first navigation, so the prompt counter sees every prompt.
  await authenticatorFor(browser);

  // Locked: the first thing the app asks for is refused until the device is unlocked.
  await softStep(journey, 'locked-before-unlock', async () => {
    // What a person does next: the setup guide's last screen offers "Open my fleet".
    if (await page.evaluate<boolean>(`document.querySelector('[data-onboarding-open-fleet]') !== null`))
      await page.click('[data-onboarding-open-fleet]');
    else await page.goto(`${origin.origin}/d/${daemonId}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await expectScreen(page, '[data-step-up-dialog]', 20_000);
    await captureScreens(page, journey, '12-locked-unlock-prompt');
    return {
      value: undefined,
      evidence: `prompt: "${String(await textNow(page, '[data-step-up-dialog]')).slice(0, 160)}"`,
    };
  });
  await setUpPasskeyAndUnlock(product, daemonId, journey, '');
}

/**
 * From a locked prompt to an unlocked device, whichever way this build asks.
 *
 * With #470, a device inside its first-passkey window is offered "Set up Face ID for this device"
 * (`[data-step-up-first-passkey]`) and ONE tap registers and unlocks. Before it, the prompt could only
 * fail ("no passkey"), the passkey was added in Settings › Security, and a second prompt unlocked. Both
 * are driven to the same end — one credential in the authenticator and no prompt left on screen — and
 * the step names say which path ran. `suffix` keeps step names unique when a journey does this twice.
 */
async function setUpPasskeyAndUnlock(
  product: Product,
  daemonId: string,
  journey: string,
  suffix: string,
): Promise<void> {
  const { browser, origin } = product;
  const page = browser.page;
  const authenticator = await authenticatorFor(browser);
  const before = await authenticator.credentials();
  if (!(await page.evaluate<boolean>(`document.querySelector('[data-step-up-dialog]') !== null`))) {
    await page.goto(`${origin.origin}/d/${daemonId}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await expectScreen(page, '[data-step-up-dialog]', 20_000);
  }
  if (await page.evaluate<boolean>(`document.querySelector('[data-step-up-first-passkey]') !== null`)) {
    await step(journey, `first-passkey-one-tap${suffix}`, async () => {
      await captureScreens(page, journey, `13-first-passkey-offer${suffix}`);
      await page.click('[data-step-up-dialog] [data-step-up-confirm]');
      await page.waitForSelector('[data-step-up-dialog]', { state: 'detached', timeout: 30_000 }).catch(async () => {
        throw new Error(`the one-tap setup did not finish: ${String(await textNow(page, '[data-step-up-dialog]'))}`);
      });
      const after = await authenticator.credentials();
      if (after !== before + 1)
        throw new Error(`the authenticator holds ${String(after)} credential(s), was ${String(before)}`);
      return {
        value: undefined,
        evidence: `one tap registered a passkey (${String(after)} credential(s)) and unlocked`,
      };
    });
    return;
  }

  // The older path: the prompt cannot succeed with no passkey, and must say so.
  await softStep(journey, `no-passkey-said${suffix}`, async () => {
    await page.click('[data-step-up-dialog] [data-step-up-confirm]');
    await expectScreen(page, '[data-step-up-failure]', 20_000);
    const failure = String(await textNow(page, '[data-step-up-failure]'));
    if (!/passkey/iu.test(failure)) throw new Error(`unlocking with no passkey says: ${failure}`);
    await captureScreens(page, journey, `13-locked-no-passkey${suffix}`);
    await page.click('[data-step-up-dialog] button:has-text("Cancel")');
    return { value: undefined, evidence: `with no passkey: "${failure.slice(0, 160)}"` };
  });
  await step(journey, `register-passkey${suffix}`, async () => {
    await page.goto(`${origin.origin}/d/${daemonId}/settings#security`, { waitUntil: 'networkidle', timeout: 30_000 });
    // The settings page reads non-exempt panels too, so the prompt may come up first; with no passkey
    // it cannot succeed, so dismiss it and use the card that registers one.
    if (await page.evaluate<boolean>(`document.querySelector('[data-step-up-dialog]') !== null`))
      await page.click('[data-step-up-dialog] button:has-text("Cancel")');
    await expectScreen(page, '[data-security-card] [data-security-add]', 20_000);
    await captureScreens(page, journey, `14-security-card-empty${suffix}`);
    await page.click('[data-security-card] [data-security-add]');
    await expectScreen(page, '[data-security-card] [data-security-passkey]', 30_000);
    const after = await authenticator.credentials();
    if (after !== before + 1)
      throw new Error(`the authenticator holds ${String(after)} credential(s), was ${String(before)}`);
    await captureScreens(page, journey, `15-security-card-passkey${suffix}`);
    return {
      value: undefined,
      evidence: `a passkey was registered by the CDP virtual authenticator (UV) and listed; ${String(after)} credential(s)`,
    };
  });
  await step(journey, `unlock${suffix}`, async () => {
    await page.goto(`${origin.origin}/d/${daemonId}`, { waitUntil: 'networkidle', timeout: 30_000 });
    const asked = await unlockIfAsked(page, 20_000);
    if (!asked) throw new Error('the app never asked to unlock a locked machine');
    await Bun.sleep(1_000);
    if (await page.evaluate<boolean>(`document.querySelector('[data-step-up-dialog]') !== null`))
      throw new Error('the unlock prompt came straight back');
    return {
      value: undefined,
      evidence: `unlocked with the passkey; prompts so far: ${String(await promptsShown(page))}`,
    };
  });
}

/** After an unlock: assert the journey that followed met no further prompt. */
async function assertNoFurtherPrompts(product: Product, journey: string, since: number): Promise<void> {
  if (!(await hasUnlockModel(product.environment))) return;
  await softStep(journey, 'no-prompts-after-unlock', async () => {
    const now = await promptsShown(product.browser.page);
    if (now !== since) throw new Error(`${String(now - since)} more prompt(s) appeared after the unlock`);
    return {
      value: undefined,
      evidence:
        'full access after one unlock: no further prompt across the first run, session, terminal, secret and setting',
    };
  });
}

interface CoreOutcome {
  readonly daemonId: string;
  readonly marker: string;
  readonly secretValue: string;
  readonly sessionUrl: string;
}

/**
 * Journeys 2, 4 and 5, in the order a new owner walks them. Run once direct and once over the relay.
 */
async function coreJourney(product: Product, journey: string): Promise<CoreOutcome> {
  const { environment, browser } = product;
  const page = browser.page;

  // Arrange — a machine that is NOT set up, which is what a fresh install is.
  const before = await asOwner(environment, 'GET', '/v1/fleet/machine');
  should((before.body as { setUp: boolean }).setUp).be.false();

  // Act / Assert — journey 2: pair.
  const daemonId = await pair(product, journey);
  await step(journey, 'device-key-non-extractable', async () => {
    const stored = await deviceGrantForLeakSearchOnly(page as never);
    if (stored.key === null) throw new Error(`no device key stored. Storage: ${stored.shape}`);
    if (!stored.key.isCryptoKey || stored.key.algorithm !== 'Ed25519' || stored.key.extractable)
      throw new Error(`the device key is ${JSON.stringify(stored.key)}`);
    if (stored.tokenFields.length !== 0)
      throw new Error(`token-shaped fields in storage: ${stored.tokenFields.join(', ')}`);
    return {
      value: undefined,
      evidence: `Ed25519 CryptoKey, extractable=false; no token-shaped field (${stored.shape.slice(0, 300)})`,
    };
  });

  // Journeys 2 (passkey) and 3 (locked until unlocked), under the unlock model when it exists.
  await registerPasskeyAndUnlock(product, daemonId, journey);
  const promptsAtUnlock = (await hasUnlockModel(environment)) ? await promptsShown(page) : 0;

  // Journey 4: the first run opens by itself.
  await step(journey, 'first-run-opens-itself', async () => {
    // With the one-tap first passkey (#470) the unlock itself lands on the stepper; navigating would leave it.
    const landed = await waitUntil(
      page,
      `document.querySelector('[data-machine-stepper="first-run"]') !== null`,
      3_000,
    ).then(
      () => true,
      () => false,
    );
    const open =
      !landed && (await page.evaluate<boolean>(`document.querySelector('[data-onboarding-open-fleet]') !== null`));
    if (landed) {
      // Already there.
    } else if (open) await page.click('[data-onboarding-open-fleet]');
    // Under the unlock model the guide's last screen was left to unlock; the documented trigger is
    // Settings › Machines on a machine that is not set up.
    else
      await page.goto(`${product.origin.origin}/d/${daemonId}/settings#machines`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
    await expectScreen(page, '[data-machine-stepper="first-run"]', 30_000);
    return {
      value: undefined,
      evidence: `the first-run stepper opened at ${page.url()} (${landed ? 'by itself, straight after the unlock' : open ? 'via Open my fleet' : 'on opening Settings › Machines'})`,
    };
  });
  await captureScreens(page, journey, '02-first-run-start');
  await reachClaudeQuestion(page, journey);
  await step(journey, 'first-run-claude-import', async () => {
    await captureScreens(page, journey, '03-first-run-claude');
    await page.click('[data-harness-import]');
    return { value: undefined, evidence: 'Claude: Import' };
  });
  await step(journey, 'first-run-codex-skip', async () => {
    await expectScreen(page, '[data-machine-stepper][data-step="codex"] [data-harness-skip]');
    await captureScreens(page, journey, '04-first-run-codex');
    await page.click('[data-harness-skip]');
    return { value: undefined, evidence: 'Codex: Skip' };
  });
  if (await page.evaluate<boolean>(`document.querySelector('[data-machine-stepper][data-step="updates"]') !== null`))
    await page.click('[data-step-next]');
  const runtimeName = 'claude-e2e';
  await step(journey, 'first-run-names', async () => {
    await expectScreen(page, '[data-machine-stepper][data-step="names"] input[data-name-input="claude"]');
    await page.fill('input[data-name-input="claude"]', runtimeName);
    await captureScreens(page, journey, '05-first-run-names');
    const asked = await answerPasswordIfAsked(page);
    await page.click('[data-change-submit]');
    await expectScreen(page, '[data-first-run-step="done"]', 30_000);
    const result = await page.evaluate<string | null>(
      `document.querySelector('[data-first-run-step="done"]').getAttribute('data-first-run-result')`,
    );
    if (result !== 'imported')
      throw new Error(
        `the first run finished with result ${String(result)}: ${String(await textNow(page, '[data-first-run-step="done"]'))}`,
      );
    return {
      value: undefined,
      evidence: `runtime named ${runtimeName}; done=${result}; password asked: ${String(asked)}`,
    };
  });
  await captureScreens(page, journey, '06-first-run-done');
  const runtimes = await asOwner(environment, 'GET', '/v1/fleet/runtimes');
  should(JSON.stringify(runtimes.body)).containEql(runtimeName);

  // Journey 5: start a session from the app, chat, see the transcript.
  const marker = `e2e-hello-${Math.trunc(Math.random() * 1e9).toString(36)}`;
  const sessionUrl = await step(journey, 'start-session', async () => {
    await page.goto(`${product.origin.origin}/d/${daemonId}/new`, { waitUntil: 'networkidle', timeout: 30_000 });
    await expectScreen(page, '#fy-new-session-prompt');
    await captureScreens(page, journey, '07-new-session');
    await page.fill('#fy-new-session-prompt', marker);
    const workspace = join(environment.paths.root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await page.fill('#fy-new-session-cwd', workspace);
    await page.press('#fy-new-session-cwd', 'Escape');
    await page.click('button:has-text("Create session")');
    await waitUntil(page, `location.pathname.includes('/session/')`, 30_000).catch(async (error: unknown) => {
      await page.screenshot({ path: join(EVIDENCE_ROOT, journey, 'fail-start-session.png') });
      throw new Error(
        `${String((error as Error).message)}. Alerts: ${String(await textNow(page, '[role="alert"]'))}. Form: ${String(await textNow(page, 'form'))}`,
      );
    });
    return { value: page.url(), evidence: `created from the app; landed on ${page.url()}` };
  });
  await step(journey, 'transcript-shows-reply', async () => {
    await expectScreen(page, '[data-transcript-kind="assistant"]', 45_000);
    const text = await textNow(page, 'section[aria-label="Transcript"]');
    // The opening prompt reaches the harness as a pointer to its turn file, so the turn file is
    // where the marker must be — and the transcript must show the harness reading that file.
    const turnFile = /Read the file (\S+turn-001\.md)/u.exec(text ?? '')?.[1];
    if (text === null || turnFile === undefined || !text.includes('FAKE-REPLY 1'))
      throw new Error(`the transcript shows no turn-1 exchange: ${String(text)}`);
    const turn = await readFile(turnFile, 'utf8');
    if (!turn.includes(marker)) throw new Error(`the turn file ${turnFile} does not carry the prompt ${marker}`);
    return {
      value: undefined,
      evidence: `transcript shows the prompt and the fake harness's reply (${text.slice(0, 160)})`,
    };
  });
  await captureScreens(page, journey, '08-session-transcript');
  await step(journey, 'chat-follow-up', async () => {
    const follow = `${marker}-again`;
    await page.fill('form.fy-composer textarea', follow);
    await page.click('form.fy-composer button[type="submit"]');
    await waitUntil(
      page,
      `(document.querySelector('section[aria-label="Transcript"]')?.textContent ?? '').includes('FAKE-REPLY 2')`,
      45_000,
    );
    return {
      value: undefined,
      evidence: 'a second message from the composer reached the harness and its reply rendered',
    };
  });

  await step(journey, 'open-terminal', async () => {
    await page.click('fieldset[aria-label="Workspace panes"] button:has-text("Terminal")');
    await expectScreen(page, '[data-terminal-deck]');
    const create = await page.evaluate<boolean>(
      `[...document.querySelectorAll('[data-terminal-deck] button')].some(b => /New terminal|Create terminal/.test(b.textContent + (b.getAttribute('aria-label') ?? '')))`,
    );
    if (create)
      await page.click(
        '[data-terminal-deck] button:has-text("New terminal"), [data-terminal-deck] [aria-label="Create terminal"]',
      );
    await expectScreen(page, '.kt-webterm__connection[data-state="live"]', 30_000);
    return { value: undefined, evidence: `a shell terminal opened and went live at ${sessionUrl}` };
  });
  await captureScreens(page, journey, '09-terminal');

  // Secrets: names only.
  const secretName = 'E2E_SECRET';
  await step(journey, 'add-secret', async () => {
    await page.goto(`${product.origin.origin}/d/${daemonId}/settings#daemons`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await expectScreen(page, '[data-daemon-panel="secrets"], [data-daemon-panel-trigger]');
    if (await page.evaluate<boolean>(`document.querySelector('[data-daemon-panel="secrets"]') !== null`))
      await page.click('[data-daemon-panel="secrets"]');
    await expectScreen(page, '[data-testid="secrets-card"]');
    await page.fill('form[aria-label="Add or replace a secret"] input:not([type="password"])', secretName);
    await page.fill('form[aria-label="Add or replace a secret"] input[type="password"]', 'fake-e2e-secret-value');
    await answerPasswordIfAsked(page);
    await page.click('form[aria-label="Add or replace a secret"] button:has-text("Save")');
    await expectScreen(page, `li[data-secret="${secretName}"]`);
    const listed = await asOwner(environment, 'GET', '/v1/secrets');
    if (JSON.stringify(listed.body).includes('fake-e2e-secret-value'))
      throw new Error('the secrets list returned a VALUE');
    const pageText = await page.evaluate<string>('document.body.textContent');
    if (pageText.includes('fake-e2e-secret-value')) throw new Error('the page shows the secret VALUE');
    return {
      value: undefined,
      evidence: `${secretName} is listed by name; neither the route nor the page shows the value`,
    };
  });
  await captureScreens(page, journey, '10-secrets');

  await step(journey, 'change-setting', async () => {
    await page.goto(`${product.origin.origin}/d/${daemonId}/settings#text-size`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await expectScreen(page, 'input[name="text-scale"][value="large"]');
    await page.click('label:has(input[name="text-scale"][value="large"])');
    await waitUntil(page, `document.documentElement.getAttribute('data-text-scale') === 'large'`, 10_000);
    return { value: undefined, evidence: 'text size Large applied (<html data-text-scale="large">)' };
  });
  await captureScreens(page, journey, '11-settings');

  // A secret is USED by name: the child gets the value, the caller sees only the redaction.
  await softStep(journey, 'use-secret', async () => {
    const used = await environment.runFy(
      ['secret', 'use', '--with', 'E2E_SECRET', '--', 'sh', '-c', 'printf "%s" "$E2E_SECRET"'],
      {
        FY_URL: environment.httpUrl(),
      },
    );
    if (used.code !== 0)
      throw new Error(`fy secret use failed (${String(used.code)}): ${used.err.trim().slice(0, 200)}`);
    if (`${used.out}${used.err}`.includes('fake-e2e-secret-value'))
      throw new Error('fy secret use printed the secret VALUE');
    if (!used.out.includes('[redacted:E2E_SECRET]'))
      throw new Error(`the child's output was not masked: ${used.out.slice(0, 200)}`);
    return {
      value: undefined,
      evidence: `the child printed the value and the caller saw "${used.out.trim().slice(0, 60)}"`,
    };
  });

  // The audit log (#461): every act above is recorded, and Settings shows it.
  const audit = await asOwner(environment, 'GET', '/v1/audit?limit=200');
  if (audit.status === 404) {
    await recordStep({
      journey,
      step: 'audit-log',
      status: 'SKIP',
      evidence: 'this build has no /v1/audit — the audit log (#461) is not merged',
    });
  } else {
    {
      // fyd's own words about its audit log, so a missing record can be told apart from a refused write.
      const log = product.environment.daemonOutput();
      const said = `${log.out}\n${log.err}`
        .split('\n')
        .filter(line => /audit/iu.test(line))
        .slice(-6)
        .join(' | ');
      if (said !== '')
        await recordStep({ journey, step: 'audit:daemon-says', status: 'FLAG', evidence: said.slice(0, 1_400) });
    }
    // Two lists: `records` is recent activity, and `kept` is the security changes (pairings, secrets,
    // grants) kept apart so activity can never push them out. A record is in the log if it is in either.
    const body = audit.body as { records?: { event: string }[]; kept?: { event: string }[] };
    const events = new Set([...(body.records ?? []), ...(body.kept ?? [])].map(record => record.event));
    for (const [event, act] of [
      ['device.paired', 'the pairing'],
      ['terminal.opened', 'the terminal'],
      ['secrets.changed', 'adding the secret'],
      ['secrets.used', 'using the secret'],
    ] as const)
      await softStep(journey, `audited:${event}`, async () => {
        if (!events.has(event)) throw new Error(`${act} is not in the audit log; it holds ${[...events].join(', ')}`);
        return { value: undefined, evidence: `${event} recorded` };
      });
    await softStep(
      journey,
      'audited:session-start',
      async () => {
        if (![...events].some(event => event.startsWith('session.')))
          throw new Error(`starting a session is not in the audit log; it holds ${[...events].join(', ')}`);
        return { value: undefined, evidence: 'a session event recorded' };
      },
      'pr461 declares session.opened but never emits it, and lists POST /v1/sessions as not audited (tests/unit/audit/not-audited.ts:23); the brief expects session start in the log',
    );
    await softStep(journey, 'settings-shows-security-log', async () => {
      await page.goto(`${product.origin.origin}/d/${daemonId}/settings#daemons`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      await unlockIfAsked(page, 3_000);
      // The log is its own tab, `security-log`, beside the passkey tab `security` (#461 next to #464).
      for (const id of ['security-log']) {
        if (await page.evaluate<boolean>(`document.querySelector('[data-security-log-panel]') !== null`)) break;
        if (await page.evaluate<boolean>(`document.querySelector('[data-daemon-panel="${id}"]') !== null`))
          await page.click(`[data-daemon-panel="${id}"]`);
        await Bun.sleep(1_000);
      }
      await expectScreen(page, '[data-security-log-panel] [data-security-log-event="terminal.opened"]', 20_000);
      await captureScreens(page, journey, '18-security-log');
      return {
        value: undefined,
        evidence: `Settings shows the security log with ${String(await page.evaluate<number>(`document.querySelectorAll('[data-security-log-event]').length`))} event(s)`,
      };
    });
  }
  await assertNoFurtherPrompts(product, journey, promptsAtUnlock);
  return { daemonId, marker, secretValue: 'fake-e2e-secret-value', sessionUrl };
}

describe('the product, from a fresh machine to a working session', () => {
  it('should pair, set the machine up, run an agent, open a terminal, use a secret and change a setting', async () => {
    // Arrange / Act / Assert — every step asserts as it goes and is written to the journey log.
    await withProduct('j02-j05-core', async product => {
      await coreJourney(product, 'j02-j05-core');
      assertNoSoftFailures('j02-j05-core');
    });
  }, 600_000);

  it('should do all of it over the local rendezvous when the direct address is unreachable', async () => {
    const journey = 'j06-relay';
    await withProduct(
      journey,
      async product => {
        // Arrange
        const relay = product.relay;
        if (relay === undefined) throw new Error('the relay journey booted without a rendezvous');
        const directBefore = relay.sinkhole.attempts();

        // Act
        const outcome = await coreJourney(product, journey);

        // Assert — it crossed THIS rendezvous, the browser knocked on the sinkhole first, the session
        // page says relay, and the rendezvous never saw a payload or a credential in the clear.
        await step(journey, 'carried-by-relay', async () => {
          const arrivals = (await relay.rendezvous.arrivals()).filter(
            entry => entry.role === 'client' && entry.daemonId === relay.fingerprint,
          );
          if (arrivals.length < 2)
            throw new Error(`only ${String(arrivals.length)} client arrival(s) at the rendezvous`);
          if (relay.sinkhole.attempts() <= directBefore) throw new Error('the browser never tried the direct address');
          await product.browser.page.goto(outcome.sessionUrl, { waitUntil: 'networkidle', timeout: 30_000 });
          await expectScreen(product.browser.page, '[data-carrier-kind]');
          // `none` means not measured YET (App.tsx: no ok measurement); the measurement lands shortly after.
          await waitUntil(
            product.browser.page,
            `document.querySelector('[data-carrier-kind]')?.getAttribute('data-carrier-kind') !== 'none'`,
            30_000,
            'the carrier to be measured',
          ).catch(() => undefined);
          const kind = await product.browser.page.evaluate<string | null>(
            `document.querySelector('[data-carrier-kind]')?.getAttribute('data-carrier-kind') ?? null`,
          );
          if (kind !== 'relay') throw new Error(`the session page reports carrier ${String(kind)}`);
          return {
            value: undefined,
            evidence: `${String(arrivals.length)} client sessions crossed the rendezvous; ${String(relay.sinkhole.attempts() - directBefore)} direct attempt(s) hit the sinkhole; data-carrier-kind=relay`,
          };
        });
        await step(journey, 'rendezvous-sees-no-payload', async () => {
          const frames = await relay.rendezvous.observations();
          const stored = await deviceGrantForLeakSearchOnly(product.browser.page as never);
          const leaks = plaintextLeaks(frames, {
            'the opening prompt': outcome.marker,
            'the follow-up message': `${outcome.marker}-again`,
            'the fake harness reply': 'FAKE-REPLY',
            'the secret value': outcome.secretValue,
            'the secret name': 'E2E_SECRET',
            'the operator password': OPERATOR_PASSWORD,
            'the admin token': await adminToken(product.environment),
            'the device id': stored.deviceId,
          });
          if (leaks.length > 0) throw new Error(leaks.join('; '));
          return {
            value: undefined,
            evidence: `${String(frames.length)} relay frames searched (utf-8 and base64): no prompt, reply, secret, password, token or device id`,
          };
        });
        assertNoSoftFailures(journey);
      },
      { relay: true },
    );
  }, 600_000);
});

const STALE_DONE_BUG =
  'packages/pwa/src/features/onboarding/onboarding-progress.ts:501 — a stored add-client walk at step "done" is kept when a NEW pairing link arrives (same route), so an already-paired browser opening a second machine\'s link, or re-pairing after a revoke/idle expiry, lands on "You are set up" and the link is ignored. MAJOR';

/**
 * Pair with a link in a browser that has paired before. A refusal to show the confirm screen is the
 * known stale-"done" bug: it is recorded as a FAIL, then the person's only way past it (forget the
 * setup guide's place) is taken so the rest of the journey can still be measured.
 */
async function pairAgain(journey: string, stepName: string, page: ProductPage, url: string): Promise<string> {
  const first = await softStep(
    journey,
    stepName,
    async () => ({ value: undefined, evidence: `confirm screen reached: ${await confirmPairing(page, url)}` }),
    STALE_DONE_BUG,
  );
  if (first) return 'direct';
  await page.evaluate(`localStorage.removeItem('fy-onboarding-v4')`);
  // A fresh document: the same URL again would be a hash-only navigation and keep the old state.
  await page.goto('about:blank');
  const settled = await confirmPairing(page, url);
  await recordStep({
    journey,
    step: `${stepName}:workaround`,
    status: 'PASS',
    evidence: `after clearing fy-onboarding-v4 the same link paired (${settled})`,
  });
  return 'workaround';
}

/** Pair, set up and start one session — the minimum a cut-off can be observed against. */
async function pairedWithSession(product: Product, journey: string): Promise<CoreOutcome> {
  return coreJourney(product, journey);
}

/** What the screen is telling the person right now, for an evidence line or a failure. */
async function whatTheScreenSays(page: ProductPage): Promise<string> {
  return page.evaluate<string>(`JSON.stringify({
    route: document.querySelector('p[data-route]')?.getAttribute('data-route') ?? null,
    live: document.querySelector('[data-live-stream]')?.getAttribute('data-live-stream') ?? null,
    session: document.querySelector('[data-session-state]')?.getAttribute('data-session-state') ?? null,
    alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')].map(n => (n.textContent ?? '').trim()).filter(Boolean).slice(0, 4),
    pairing: document.querySelector('[data-pairing-stage]')?.getAttribute('data-pairing-stage') ?? null,
  })`);
}

/** The words a person needs after losing access: that this device must be paired again. */
const REPAIR_WORDS = /pair(ed)? (this device|it )?again|no longer paired|not paired|pair this (device|browser)/iu;

describe('signing a harness in from the first run', () => {
  it('should sign Codex in from the first run with the paste-a-link flow', async () => {
    const journey = 'j04-codex-sign-in';
    await withProduct(journey, async product => {
      // Arrange — paired, on the first run, Claude imported.
      const { environment, browser } = product;
      const page = browser.page;
      const daemonId = await pair(product, journey);
      await registerPasskeyAndUnlock(product, daemonId, journey);
      const landed = await waitUntil(
        page,
        `document.querySelector('[data-machine-stepper="first-run"]') !== null`,
        3_000,
      ).then(
        () => true,
        () => false,
      );
      if (landed) {
        // The one-tap setup (#470) already landed on the stepper.
      } else if (await page.evaluate<boolean>(`document.querySelector('[data-onboarding-open-fleet]') !== null`))
        await page.click('[data-onboarding-open-fleet]');
      else
        await page.goto(`${product.origin.origin}/d/${daemonId}/settings#machines`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
      await expectScreen(page, '[data-machine-stepper="first-run"]', 30_000);
      await reachClaudeQuestion(page, journey);
      await page.click('[data-harness-import]');

      // Act — Codex: Sign in now → device code → switch to a link → paste the callback address.
      await softStep(journey, 'codex-sign-in-now', async () => {
        await expectScreen(page, '[data-machine-stepper][data-step="codex"] [data-harness-sign-in]');
        await page.click('[data-harness-sign-in]');
        await expectScreen(page, '[data-first-run-sign-in="codex"]');
        await captureScreens(page, journey, '50-codex-sign-in-start');
        await answerPasswordIfAsked(page);
        await page.click('[data-first-run-sign-in="codex"] [data-change-submit]');
        await expectScreen(page, '[data-codex-login-user-code]', 30_000);
        const code = await textNow(page, '[data-codex-login-user-code]');
        if (code === null || !code.includes('FYE2-E2E01')) throw new Error(`the device code shown is ${String(code)}`);
        return { value: undefined, evidence: `the panel shows the fake Codex device code ${code}` };
      });
      await captureScreens(page, journey, '51-codex-device-code');
      await softStep(journey, 'codex-paste-link', async () => {
        await page.click('[data-codex-login-use-link] button');
        await expectScreen(page, 'textarea[name="codex-login-address"]', 30_000);
        await captureScreens(page, journey, '52-codex-link');
        const authorize = await page.evaluate<string | null>(
          `[...document.querySelectorAll('[data-codex-login] code')].map(node => (node.textContent ?? '').trim()).find(text => text.startsWith('https://auth.openai.com/')) ?? null`,
        );
        const state = authorize === null ? null : new URL(authorize).searchParams.get('state');
        if (state === null)
          throw new Error(
            `no authorize link with a state on the panel: ${String(await textNow(page, '[data-codex-login]'))}`,
          );
        await page.fill(
          'textarea[name="codex-login-address"]',
          `http://localhost:1455/auth/callback?code=fake-e2e-code&state=${state}`,
        );
        await page.click('[data-codex-login] button:has-text("Finish sign-in")');
        // On success the panel says complete and the step re-reads the scan at once, so the panel can be
        // gone before a poll sees it. The re-read is the durable signal: Codex now reads Signed in.
        await waitUntil(
          page,
          `document.querySelector('[data-codex-login="complete"]') !== null || (document.querySelector('[data-first-run-sign-in="codex"]') === null && /Signed in/.test(document.querySelector('[data-machine-stepper][data-step="codex"]')?.textContent ?? ''))`,
          45_000,
          'the Codex sign-in to complete',
        ).catch(async (error: unknown) => {
          await page.screenshot({ path: join(EVIDENCE_ROOT, journey, 'fail-codex-paste.png') });
          throw new Error(
            `${String((error as Error).message)}. Panel: ${String(await textNow(page, '[data-credential-sign-in]'))}. States: ${await page.evaluate<string>(`[...document.querySelectorAll('[data-codex-login],[data-credential-sign-in]')].map(n => n.getAttribute('data-codex-login') ?? n.getAttribute('data-credential-sign-in')).join(',')`)}`,
          );
        });
        return {
          value: undefined,
          evidence: `pasted the callback for state ${state.slice(0, 14)}…; the sign-in completed`,
        };
      });
      await captureScreens(page, journey, '53-codex-signed-in');

      // Assert — the daemon ran THIS fake, never the host's codex, and the login is now a credential.
      await softStep(journey, 'codex-credential-recorded', async () => {
        const invocations = await readFile(product.tools.codexLog, 'utf8').catch(() => '');
        if (!invocations.includes('login'))
          throw new Error(`the fake codex never saw a login: ${invocations.slice(0, 300)}`);
        const credentials = await asOwner(environment, 'GET', '/v1/fleet/credentials');
        const text = JSON.stringify(credentials.body);
        if (!/codex/iu.test(text)) throw new Error(`no Codex credential after signing in: ${text.slice(0, 400)}`);
        if (text.includes('fake-e2e-access') || text.includes('fake-e2e-refresh'))
          throw new Error('the credentials route returned a token value');
        return {
          value: undefined,
          evidence: `fake codex ran (${String(invocations.trim().split('\\n').length)} invocation(s)); /v1/fleet/credentials lists a Codex login and no token value`,
        };
      });
      // A sign-in left pending when the daemon stops must not outlive it.
      await softStep(
        journey,
        'pending-sign-in-ends-with-daemon',
        async () => {
          const started = await asOwner(environment, 'POST', '/v1/fleet/login', {
            credentialId: 'codex-you',
            method: 'link',
          });
          if (started.status >= 300)
            throw new Error(
              `starting a second sign-in answered ${String(started.status)}: ${JSON.stringify(started.body).slice(0, 200)}`,
            );
          await Bun.sleep(1_500);
          await environment.stopDaemon();
          const left = await reapLeftovers(environment, journey);
          if (left.length > 0) throw new Error(`still running after fyd stopped: ${left.join(' | ').slice(0, 400)}`);
          return { value: undefined, evidence: 'a pending Codex sign-in ended with its daemon' };
        },
        'fyd shutdown (SIGTERM) does not end a pending harness login child (HarnessLoginService, packages/daemon/src/lib/fleet-login/service.ts, has no shutdown/cancel-all and packages/daemon/bin/fyd.ts:4698 never ends its flows on stop): it is re-parented to init and keeps localhost:1455, so the next Codex sign-in on the machine cannot listen. MAJOR',
      );
      assertNoSoftFailures(journey);
    });
  }, 600_000);
});

describe('the unlock model: passkeys, unlock, and who may loosen security', () => {
  it('should re-lock on restart, tighten from the device, loosen only at the machine, and audit both', async () => {
    const journey = 'j03-j12-unlock-security';
    await withProduct(journey, async product => {
      const { environment, browser, origin } = product;
      const page = browser.page;
      if (!(await hasUnlockModel(environment))) {
        // Arrange / Act / Assert — nothing to drive on a build without the model.
        await recordStep({
          journey,
          step: 'unlock-model',
          status: 'SKIP',
          evidence: 'no /v1/security on this build (#464 not merged)',
        });
        return;
      }

      // Arrange — paired, a passkey registered, unlocked.
      const daemonId = await pair(product, journey);
      await registerPasskeyAndUnlock(product, daemonId, journey);
      const stored = await deviceGrantForLeakSearchOnly(page as never);

      // Act / Assert — a restart forgets the unlock; the next open asks again and one passkey answers.
      await softStep(journey, 'relock-on-restart', async () => {
        await environment.stopDaemon();
        await bootDaemon(environment, product.boot);
        await page.goto(`${origin.origin}/d/${daemonId}`, { waitUntil: 'networkidle', timeout: 30_000 });
        if (!(await unlockIfAsked(page, 20_000)))
          throw new Error('a restarted machine did not ask to be unlocked again');
        return {
          value: undefined,
          evidence: 'after fyd restarted, the app asked to unlock and the passkey unlocked it',
        };
      });

      // Tighten from the device: shorter unlock validity.
      await softStep(journey, 'tighten-from-device', async () => {
        await page.goto(`${origin.origin}/d/${daemonId}/settings#security`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        await unlockIfAsked(page, 3_000);
        await expectScreen(page, '[data-security-settings] [data-security-input="unlockValidityHours"]', 20_000);
        await captureScreens(page, journey, '16-security-settings');
        await page.fill('[data-security-input="unlockValidityHours"]', '4');
        await page.click('[data-security-save="unlockValidityHours"]');
        await waitUntil(
          page,
          `(document.querySelector('[data-security-value="unlockValidityHours"]')?.textContent ?? '').includes('4')`,
          15_000,
          'the new validity to show',
        );
        const read = await asOwner(environment, 'GET', '/v1/security');
        const hours = (read.body as { settings?: { unlockValidityHours?: number } }).settings?.unlockValidityHours;
        if (hours !== 4) throw new Error(`the daemon reads unlockValidityHours=${String(hours)}`);
        return { value: undefined, evidence: 'the device shortened the unlock to 4 h; the daemon holds 4' };
      });

      // Loosen from the device: the control refuses, and says where to do it.
      await softStep(journey, 'loosen-refused-on-device', async () => {
        await page.fill('[data-security-input="unlockValidityHours"]', '12');
        const disabled = await page.evaluate<boolean>(
          `document.querySelector('[data-security-save="unlockValidityHours"]')?.disabled === true`,
        );
        const note = String(await textNow(page, '[data-security-note="unlockValidityHours"]'));
        await captureScreens(page, journey, '17-security-loosen-refused');
        if (!disabled) throw new Error('the device is offered a Save that would loosen security');
        if (!/fy daemon security set/u.test(note))
          throw new Error(`the refusal does not say where to loosen it: ${note}`);
        return { value: undefined, evidence: `Save disabled; note: "${note.slice(0, 160)}"` };
      });

      // Loosen at the machine.
      await softStep(journey, 'loosen-at-machine', async () => {
        const set = await environment.runFy(['daemon', 'security', 'set', 'unlockValidityHours', '8'], {
          FY_URL: environment.httpUrl(),
        });
        if (set.code !== 0) throw new Error(`fy daemon security set failed (${String(set.code)}): ${set.err.trim()}`);
        const read = await asOwner(environment, 'GET', '/v1/security');
        const hours = (read.body as { settings?: { unlockValidityHours?: number } }).settings?.unlockValidityHours;
        if (hours !== 8) throw new Error(`after fy set, the daemon reads ${String(hours)}`);
        return {
          value: undefined,
          evidence: `fy daemon security set → "${set.out.trim().slice(0, 120)}"; the daemon holds 8`,
        };
      });

      // Both changes are in the audit log (#461) and Settings shows them.
      if ((await asOwner(environment, 'GET', '/v1/audit')).status === 404)
        await recordStep({
          journey,
          step: 'security-changes-audited',
          status: 'SKIP',
          evidence: 'no audit log on this build (#461 not merged)',
        });
      else
        await softStep(
          journey,
          'security-changes-audited',
          async () => {
            const audit = await environment.runFy(['daemon', 'audit', '--json'], { FY_URL: environment.httpUrl() });
            if (audit.code !== 0)
              throw new Error(`fy daemon audit failed (${String(audit.code)}): ${audit.err.trim().slice(0, 200)}`);
            if (!/security/u.test(audit.out))
              throw new Error(`the audit log has no security-settings change: ${audit.out.slice(0, 400)}`);
            return { value: undefined, evidence: 'fy daemon audit lists the security changes' };
          },
          'cross-PR gap: #461 audits the deleted password routes and has no rule for PATCH /v1/security (pr461 packages/daemon/src/lib/audit/routes.ts:61,63); #464 writes security changes to state/security-audit.jsonl instead. MAJOR if the audit log is meant to hold them',
        );

      // fy passkey window re-opens registration for one device, and a second passkey can be added.
      await softStep(journey, 'passkey-window', async () => {
        const opened = await environment.runFy(['passkey', 'window', stored.deviceId], {
          FY_URL: environment.httpUrl(),
        });
        if (opened.code !== 0)
          throw new Error(`fy passkey window failed (${String(opened.code)}): ${opened.err.trim()}`);
        // A SECOND authenticator (a USB security key): the platform one already holds a credential for
        // this device, and WebAuthn's excludeCredentials rightly stops it registering twice.
        const cdp = await browser.cdp();
        const { authenticatorId } = await cdp.send<{ authenticatorId: string }>('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2',
            transport: 'usb',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        });
        const authenticator = {
          credentials: async () =>
            (await cdp.send<{ credentials: unknown[] }>('WebAuthn.getCredentials', { authenticatorId })).credentials
              .length,
        };
        const before = await authenticator.credentials();
        await page.goto(`${origin.origin}/d/${daemonId}/settings#security`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        await unlockIfAsked(page, 3_000);
        await expectScreen(page, '[data-security-card] [data-security-add]', 20_000);
        await page.click('[data-security-card] [data-security-add]');
        await waitUntil(
          page,
          `document.querySelectorAll('[data-security-card] [data-security-passkey]').length >= 2`,
          30_000,
          'a second passkey',
        ).catch(async (error: unknown) => {
          throw new Error(
            `${String((error as Error).message)}. Card says: ${String(await textNow(page, '[data-security-card]'))}`,
          );
        });
        if ((await authenticator.credentials()) !== before + 1)
          throw new Error('the authenticator did not gain a credential');
        return {
          value: undefined,
          evidence: `"${opened.out.trim().slice(0, 140)}"; a second passkey was then added from the device`,
        };
      });

      // A limited pairing gives a second device only fleet.use.
      await softStep(journey, 'pair-limited', async () => {
        const limited = await mintPairingLink(environment, origin.origin, ['--limited']);
        const second = await launchProductBrowser(product.teardown);
        await confirmPairing(second.page, limited.url);
        const devices = await asOwner(environment, 'GET', '/v1/pair/devices');
        const rows = (devices.body as { devices: { id: string; grants?: unknown }[] }).devices;
        const fresh = rows.find(row => row.id !== stored.deviceId);
        if (fresh === undefined) throw new Error('the limited device is not listed');
        const grants = JSON.stringify(fresh.grants ?? {});
        if (/"terminal":\s*\{[^}]*"use":\s*true/u.test(grants))
          throw new Error(`a --limited device holds terminal.use: ${grants}`);
        return { value: undefined, evidence: `limited device grants: ${grants.slice(0, 200)}` };
      });
      assertNoSoftFailures(journey);
    });
  }, 900_000);
});

describe('access ends when it should, and the person is told', () => {
  it('should cut a revoked device off at once, say so, and pair again', async () => {
    const journey = 'j08-revoke';
    await withProduct(journey, async product => {
      // Arrange — a paired browser watching a live session.
      const { environment, browser } = product;
      const page = browser.page;
      const outcome = await pairedWithSession(product, journey);
      await page.goto(outcome.sessionUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      await waitUntil(
        page,
        `document.querySelector('[data-live-stream="live"]') !== null`,
        30_000,
        'a live session stream',
      );
      const stored = await deviceGrantForLeakSearchOnly(page as never);

      // Act — the owner revokes the device. On main there is no `fy device revoke`, so the route.
      const cli = await environment.runFy(['device', 'revoke', stored.deviceId, '--yes'], {
        FY_URL: environment.httpUrl(),
      });
      const viaCli = cli.code === 0;
      await recordStep({
        journey,
        step: 'revoke-command',
        status: viaCli ? 'PASS' : 'FLAG',
        evidence: viaCli
          ? 'fy device revoke succeeded'
          : `fy device revoke is not a command here (exit ${String(cli.code)}: ${cli.err.trim().split('\n')[0] ?? ''}); revoked through DELETE /v1/pair/devices/:id`,
        ...(viaCli
          ? {}
          : {
              bug: 'no CLI verb revokes a device on main (packages/cli/src/lib/pair/commands.ts:33-37 only offers `fy pair`); expected from #464 — minor until then',
            }),
      });
      const revokedAt = Date.now();
      if (!viaCli) {
        const revoked = await asOwner(environment, 'DELETE', `/v1/pair/devices/${encodeURIComponent(stored.deviceId)}`);
        should(revoked.status).equal(200);
      }

      // Assert — the live view stops at once, and the screen says what to do.
      await step(journey, 'cut-off-immediately', async () => {
        await waitUntil(
          page,
          `document.querySelector('[data-live-stream="live"]') === null`,
          10_000,
          'the live stream to stop',
        );
        return {
          value: undefined,
          evidence: `the live stream left "live" ${String(Date.now() - revokedAt)}ms after the revoke: ${await whatTheScreenSays(page)}`,
        };
      });
      await Bun.sleep(3_000);
      await captureScreens(page, journey, '20-after-revoke');
      await softStep(
        journey,
        'told-to-pair-again',
        async () => {
          const said = await whatTheScreenSays(page);
          if (!REPAIR_WORDS.test(said)) {
            await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
            await Bun.sleep(3_000);
            await captureScreens(page, journey, '21-after-revoke-reload');
            const reloaded = await whatTheScreenSays(page);
            if (!REPAIR_WORDS.test(reloaded))
              throw new Error(
                `a revoked device is never told to pair again. Live screen: ${said}. After reload: ${reloaded}`,
              );
            return { value: undefined, evidence: `only after a reload: ${reloaded}` };
          }
          return { value: undefined, evidence: said };
        },
        'packages/pwa/src/lib/relay-session.ts:979 — close 4403 (unknown/revoked/idle device) is reported as a generic rendezvous end, even on a direct carrier; packages/relay/src/lib/connection.ts:369-375 then says direct was not reachable; RELAY_CLOSE_CODES.authRejected is never read in packages/pwa, so no screen ever says pair again. MAJOR',
      );

      // And pairing again works.
      const logMark = environment.daemonOutput().err.length + environment.daemonOutput().out.length;
      const repaired = await softStep(
        journey,
        'pair-again',
        async () => {
          const link = await mintPairingLink(environment, product.origin.origin);
          const settled = await pairAgain(journey, 'pair-again-link', page, link.url);
          // A revoke forgets the device's passkeys, so the new pairing is locked until it sets one up again.
          if (await hasUnlockModel(environment))
            await setUpPasskeyAndUnlock(product, outcome.daemonId, journey, ':re-pair');
          await page.goto(outcome.sessionUrl, { waitUntil: 'networkidle', timeout: 30_000 });
          await waitUntil(
            page,
            `document.querySelector('[data-live-stream="live"]') !== null`,
            30_000,
            'a live stream after pairing again',
          );
          return { value: undefined, evidence: `paired again (${settled}) and the session streams live` };
        },
        'the same browser cannot pair again with the machine that revoked it — see the daemon log excerpt in pair-again:daemon-log. MAJOR',
      );
      if (!repaired) {
        const log = environment.daemonOutput();
        await recordStep({
          journey,
          step: 'pair-again:daemon-log',
          status: 'FLAG',
          evidence: `${log.out}\n${log.err}`.slice(Math.max(0, logMark - 200)).slice(-1_400),
        });
        const fresh = await launchProductBrowser(product.teardown);
        await softStep(journey, 'pair-again:fresh-browser', async () => {
          const link = await mintPairingLink(environment, product.origin.origin);
          return {
            value: undefined,
            evidence: `a NEW browser pairs with the same machine: ${await confirmPairing(fresh.page, link.url)}`,
          };
        });
      }
      assertNoSoftFailures(journey);
    });
  }, 600_000);

  it('should expire a device left idle past the idle period and ask for a new pairing', async () => {
    const journey = 'j07-idle';
    await withProduct(journey, async product => {
      // Arrange — paired, then the daemon stopped and the device's last sighting moved 31 days back.
      const { environment, browser } = product;
      const page = browser.page;
      const outcome = await pairedWithSession(product, journey);
      const stored = await deviceGrantForLeakSearchOnly(page as never);
      const devicesFile = await findStateFileContaining(environment.paths.fyHome, stored.deviceId);
      await environment.stopDaemon();
      const document = await readFile(devicesFile, 'utf8');
      const aged = new Date(Date.now() - 31 * 24 * 3_600_000).toISOString();
      const rewritten = document
        .replace(/"(lastSeenAt|createdAt)":"[^"]+"/gu, `"$1":"${aged}"`)
        .replace(/"(lastSeenAt|createdAt)": "[^"]+"/gu, `"$1": "${aged}"`);
      if (rewritten === document) throw new Error(`no lastSeenAt in ${devicesFile} to age`);
      await writeFile(devicesFile, rewritten, 'utf8');

      // Act
      await bootDaemon(environment, product.boot);
      await page.goto(outcome.sessionUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      await Bun.sleep(5_000);
      await captureScreens(page, journey, '30-idle-expired');

      // Assert
      await step(journey, 'idle-device-refused', async () => {
        const listed = await asOwner(environment, 'GET', '/v1/pair/devices');
        if (JSON.stringify(listed.body).includes(stored.deviceId))
          throw new Error(`the daemon still lists the idle device: ${JSON.stringify(listed.body).slice(0, 300)}`);
        if (await page.evaluate<boolean>(`document.querySelector('[data-live-stream="live"]') !== null`))
          throw new Error('the idle-expired device still streams live');
        return {
          value: undefined,
          evidence: `device aged to ${aged} in ${devicesFile}; the daemon dropped it and the app is not live`,
        };
      });
      await softStep(
        journey,
        'idle-told-to-pair-again',
        async () => {
          const said = await whatTheScreenSays(page);
          if (!REPAIR_WORDS.test(said)) throw new Error(`an idle-expired device is not told to pair again: ${said}`);
          return { value: undefined, evidence: said };
        },
        'packages/pwa/src/lib/relay-session.ts:979 — close 4403 (unknown/revoked/idle device) is reported as a generic rendezvous end, even on a direct carrier; packages/relay/src/lib/connection.ts:369-375 then says direct was not reachable; RELAY_CLOSE_CODES.authRejected is never read in packages/pwa, so no screen ever says pair again. MAJOR',
      );
      assertNoSoftFailures(journey);
    });
  }, 600_000);

  it('should record that the lease, idle and session-cap durations have no test seam', async () => {
    // Arrange / Act / Assert — a declared gap, not a pass. See the report's journey 7.
    await recordStep({
      journey: 'j07-lease-cap',
      step: 'lease-4441-and-12h-cap',
      status: process.env.FY_E2E_LONG === '1' ? 'FAIL' : 'SKIP',
      evidence:
        'ACCESS_LEASE_SECONDS=900, MAX_SESSION_SECONDS=43200 and DEVICE_IDLE_EXPIRY_DAYS=30 are compiled constants (packages/protocol/src/lib/relay-session.ts:79,92; pairing.ts:56) with no config key, env var, flag or clock seam in the compiled fyd (fyd.ts:5364 hard-wires Date.now). A silent 4441 reopen and the 12 h reconnect cannot be driven end to end without waiting them out.',
      bug: 'testability gap, minor: give fyd a test-only clock or a short-duration override so lease end / cap are provable in e2e',
    });
    should(true).be.true();
  });
});

describe('one browser, two machines', () => {
  it('should hold two machines apart: separate pairings, separate sessions, revoking one leaves the other', async () => {
    const journey = 'j09-two-machines';
    await withProduct(journey, async product => {
      // Arrange — machine A is set up and has a session; machine B is a second fresh install.
      const page = product.browser.page;
      const a = await coreJourney(product, journey);
      await withE2eEnvironment(async second => {
        const tools = await installFakeTools(second);
        const directory = await startRelayDirectory();
        const configPath = await writeDaemonConfig(join(second.paths.root, 'daemon.json'), {
          bindPort: second.ports.api,
          appOrigins: [product.origin.origin],
        });
        await bootDaemon(second, { configPath, directoryOrigin: directory.origin, env: fakeToolEnvironment(tools) });
        await ensureOperatorPassword(second);

        // Act — pair the SAME browser with B.
        const link = await mintPairingLink(second, product.origin.origin);
        const bId = decodeURIComponent(/(?:^|;)fp=([^;]+)/u.exec(link.fragment)?.[1] ?? '');
        const settled = await pairAgain(journey, 'pair-second-machine-link', page, link.url);
        await softStep(journey, 'pair-second-machine', async () => {
          const connections = await page.evaluate<number>(
            `new Promise(resolve => { const r = indexedDB.open('ferretry-pwa'); r.onsuccess = () => { const q = r.result.transaction('connections').objectStore('connections').getAll(); q.onsuccess = () => { const raw = q.result[0]; const doc = typeof raw === 'string' ? JSON.parse(raw) : raw; resolve((doc?.connections ?? []).length); }; }; })`,
          );
          if (connections !== 2)
            throw new Error(`the browser holds ${String(connections)} connection(s) after pairing a second machine`);
          return {
            value: undefined,
            evidence: `paired with B (${settled}); the browser holds two connections, A ${a.daemonId.slice(0, 18)}… and B ${bId.slice(0, 18)}…`,
          };
        });
        await page.goto(`${product.origin.origin}/`, { waitUntil: 'networkidle', timeout: 30_000 });
        await Bun.sleep(1_500);
        await captureScreens(page, journey, '40-two-machines-home');
        await page.goto(`${product.origin.origin}/d/${bId}/settings#machines`, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        await Bun.sleep(1_500);
        await captureScreens(page, journey, '41-machine-b-settings');

        // Assert — A's session is still A's, B has none, and each answers only for itself.
        // An unlock is per machine: A is unlocked, and that buys nothing at B.
        if (await hasUnlockModel(second))
          await softStep(journey, 'unlock-is-per-machine', async () => {
            await page.goto(`${product.origin.origin}/d/${bId}`, { waitUntil: 'networkidle', timeout: 30_000 });
            await expectScreen(page, '[data-step-up-dialog]', 20_000);
            const said = String(await textNow(page, '[data-step-up-dialog]'));
            await captureScreens(page, journey, '42-machine-b-locked');
            await page.click('[data-step-up-dialog] button:has-text("Cancel")');
            await page.goto(a.sessionUrl, { waitUntil: 'networkidle', timeout: 30_000 });
            await Bun.sleep(1_500);
            if (await page.evaluate<boolean>(`document.querySelector('[data-step-up-dialog]') !== null`)) {
              // Say WHICH machine is asking: A losing its unlock and B's prompt surfacing over A's page are
              // different defects.
              const asking = String(await textNow(page, '[data-step-up-dialog] [data-step-up-machine]'));
              await captureScreens(page, journey, '43-prompt-over-machine-a');
              // Both machines run on this host, so the name cannot say which one asks. The passkey can: only
              // A holds one, so B's prompt answers "no passkey" and A's would unlock.
              // A first-passkey offer can only be B's: A already holds a passkey and is never offered one.
              const firstPasskeyOffer = await page.evaluate<boolean>(
                `document.querySelector('[data-step-up-first-passkey]') !== null`,
              );
              if (firstPasskeyOffer)
                throw new Error(
                  `on A's session page machine B's "set up a passkey" offer appeared (named "${asking}", the host both share); a locked second machine's prompt surfaces over the first machine's pages`,
                );
              await page.click('[data-step-up-dialog] [data-step-up-confirm]');
              await Bun.sleep(3_000);
              const outcome = (await page.evaluate<boolean>(`document.querySelector('[data-step-up-dialog]') === null`))
                ? "it unlocked with A's passkey, so A had lost its unlock"
                : `it answered "${String(await textNow(page, '[data-step-up-failure]')).slice(0, 120)}", so it is B's prompt shown over A's page`;
              throw new Error(
                `on A's session page an unlock prompt appeared naming "${asking}" (both machines share that host name); answering it: ${outcome}`,
              );
            }
            return {
              value: undefined,
              evidence: `unlocked at A, B still asks: "${said.slice(0, 100)}"; A stays unlocked`,
            };
          });
        else
          await recordStep({
            journey,
            step: 'unlock-is-per-machine',
            status: 'SKIP',
            evidence: 'no unlock model on this build (#464 not merged)',
          });
        await softStep(journey, 'sessions-stay-per-machine', async () => {
          const bSessions = await asOwner(second, 'GET', '/v1/sessions');
          if (JSON.stringify(bSessions.body).includes(a.sessionUrl.split('/session/')[1] ?? '@@'))
            throw new Error("machine B lists machine A's session");
          await page.goto(a.sessionUrl, { waitUntil: 'networkidle', timeout: 30_000 });
          await waitUntil(
            page,
            `document.querySelector('[data-live-stream="live"]') !== null`,
            30_000,
            "A's session live",
          );
          return { value: undefined, evidence: "A's session streams from A; B does not list it" };
        });
        await softStep(journey, 'revoke-at-b-leaves-a', async () => {
          const bDevices = await asOwner(second, 'GET', '/v1/pair/devices');
          const id = (bDevices.body as { devices: { id: string }[] }).devices[0]?.id;
          if (id === undefined) throw new Error('machine B lists no device');
          const removed = await asOwner(second, 'DELETE', `/v1/pair/devices/${encodeURIComponent(id)}`);
          if (removed.status !== 200) throw new Error(`revoking at B answered ${String(removed.status)}`);
          await Bun.sleep(2_000);
          await page.goto(a.sessionUrl, { waitUntil: 'networkidle', timeout: 30_000 });
          await waitUntil(
            page,
            `document.querySelector('[data-live-stream="live"]') !== null`,
            30_000,
            "A's session still live after B revoked this browser",
          );
          const aDevices = await asOwner(product.environment, 'GET', '/v1/pair/devices');
          if ((aDevices.body as { devices: unknown[] }).devices.length !== 1)
            throw new Error('A lost its device when B revoked');
          return {
            value: undefined,
            evidence: 'B revoked this browser; A still lists it and its session still streams',
          };
        });

        // The cross-machine parts of journey 9 need #464 (step-up per daemon) and #468 (clone shows commands).
        await recordStep({
          journey,
          step: 'clone-shows-commands',
          status: 'SKIP',
          evidence: 'clone A→B with every hook/MCP command shown needs #468',
        });
        await recordStep({
          journey,
          step: 'per-machine-notifications',
          status: 'SKIP',
          evidence:
            'Web Push delivery needs a push service; headless Chrome has none on loopback (see memory: CDP push delivery drops)',
        });
        await second.stopDaemon();
        await reapLeftovers(second, journey);
      });
      assertNoSoftFailures(journey);
    });
  }, 900_000);
});

/** The state file under `home` whose text mentions `needle` — how the idle journey finds the device record. */
async function findStateFileContaining(home: string, needle: string): Promise<string> {
  const glob = new Bun.Glob('**/*.json');
  for await (const relative of glob.scan({ cwd: home, dot: true })) {
    const path = join(home, relative);
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text.includes(needle) && /lastSeenAt/u.test(text)) return path;
  }
  throw new Error(`no state file under ${home} records ${needle.slice(0, 12)}…`);
}
