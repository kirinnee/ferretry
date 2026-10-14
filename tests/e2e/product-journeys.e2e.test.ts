import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { type E2eEnvironment, withE2eEnvironment } from './fixture';
import {
  addVirtualAuthenticator,
  answerPasswordIfAsked,
  asOwner,
  bootDaemon,
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
  recordStep,
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
}

/** Boot one machine and one browser, unpaired. Every journey starts here. */
async function withProduct(journey: string, body: (product: Product) => Promise<void>): Promise<void> {
  const teardown = harnessTeardown();
  try {
    await withE2eEnvironment(async environment => {
      const directory = await startRelayDirectory();
      // No rendezvous for the direct journeys: the advertisement says "none", so the daemon is
      // direct-only and nothing here can be carried by a relay by accident.
      directory.publish(null);
      const distDir = await buildPwaBundle(directory.origin);
      const origin = await startPwaOrigin(distDir, teardown);
      const tools = await installFakeTools(environment);
      const configPath = await writeDaemonConfig(join(environment.paths.root, 'daemon.json'), {
        bindPort: environment.ports.api,
        appOrigins: [origin.origin],
      });
      await bootDaemon(environment, { configPath, directoryOrigin: directory.origin, env: fakeToolEnvironment(tools) });
      teardown.add('daemon', async () => {
        await environment.stopDaemon();
      });
      const browser = await launchProductBrowser(teardown);
      await recordStep({ journey, step: 'boot', status: 'PASS', evidence: `fyd on ${environment.httpUrl()}, app ${origin.origin}` });
      await body({ environment, teardown, origin, tools, browser });
      should(browser.pageErrors).be.empty();
      should(origin.missingAssets()).be.empty();
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
    return { value: minted, evidence: `fy pair --no-wait printed a ${minted.fragment.slice(0, 3)} link (password model: ${model})` };
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

describe('the product, from a fresh machine to a working session', () => {
  it('should pair, set the machine up, run an agent, open a terminal, use a secret and change a setting', async () => {
    const journey = 'j02-j05-core';
    await withProduct(journey, async product => {
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
        if (stored.tokenFields.length !== 0) throw new Error(`token-shaped fields in storage: ${stored.tokenFields.join(', ')}`);
        return { value: undefined, evidence: `Ed25519 CryptoKey, extractable=false; no token-shaped field (${stored.shape.slice(0, 300)})` };
      });

      // Journey 2 (passkey) and 3 (locked until unlocked) need the unlock model.
      const unlock = await asOwner(environment, 'GET', '/v1/security');
      if (unlock.status === 404) {
        await recordStep({ journey, step: 'passkey-unlock', status: 'SKIP', evidence: 'this build has no /v1/security — the unlock model (#464) is not merged' });
      } else {
        const authenticator = await addVirtualAuthenticator(browser);
        await recordStep({ journey, step: 'passkey-unlock', status: 'FAIL', evidence: `unlock model present (authenticator ${authenticator.authenticatorId}); the unlock journey is written once #464 lands` });
      }

      // Journey 4: the first run opens by itself.
      await step(journey, 'first-run-opens-itself', async () => {
        const open = await page.evaluate<boolean>(`document.querySelector('[data-onboarding-open-fleet]') !== null`);
        if (open) await page.click('[data-onboarding-open-fleet]');
        await expectScreen(page, '[data-machine-stepper="first-run"]', 30_000);
        return { value: undefined, evidence: `the first-run stepper opened at ${page.url()} (${open ? 'via Open my fleet' : 'directly'})` };
      });
      await captureScreens(page, journey, '02-first-run-start');
      // On main the scan itself is a governed read: a device has to give the operator password first.
      if (await page.evaluate<boolean>(`document.querySelector('[data-first-run-locked]') !== null`)) {
        await answerPasswordIfAsked(page);
        await page.click('[data-first-run-locked] [data-change-submit]');
        await page.waitForSelector('[data-first-run-locked]', { state: 'detached', timeout: 20_000 });
        await recordStep({ journey, step: 'first-run-scan-gate', status: 'PASS', evidence: 'the scan asked for the operator password and read the machine once given it' });
      }
      // The tools step comes first when a tool is missing; both are "installed" here, so it may not.
      if (await page.evaluate<boolean>(`document.querySelector('[data-machine-stepper][data-step="tools"]') !== null`))
        await page.click('[data-step-next]');
      await step(journey, 'first-run-claude-import', async () => {
        await expectScreen(page, '[data-machine-stepper][data-step="claude"] [data-harness-import]');
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
        const result = await page.evaluate<string | null>(`document.querySelector('[data-first-run-step="done"]').getAttribute('data-first-run-result')`);
        if (result !== 'imported') throw new Error(`the first run finished with result ${String(result)}: ${String(await textNow(page, '[data-first-run-step="done"]'))}`);
        return { value: undefined, evidence: `runtime named ${runtimeName}; done=${result}; password asked: ${String(asked)}` };
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
          throw new Error(`${String((error as Error).message)}. Alerts: ${String(await textNow(page, '[role="alert"]'))}. Form: ${String(await textNow(page, 'form'))}`);
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
        return { value: undefined, evidence: `transcript shows the prompt and the fake harness's reply (${text.slice(0, 160)})` };
      });
      await captureScreens(page, journey, '08-session-transcript');
      await step(journey, 'chat-follow-up', async () => {
        const follow = `${marker}-again`;
        await page.fill('form.fy-composer textarea', follow);
        await page.click('form.fy-composer button[type="submit"]');
        await waitUntil(page, `(document.querySelector('section[aria-label="Transcript"]')?.textContent ?? '').includes('FAKE-REPLY 2')`, 45_000);
        return { value: undefined, evidence: 'a second message from the composer reached the harness and its reply rendered' };
      });

      await step(journey, 'open-terminal', async () => {
        await page.click('fieldset[aria-label="Workspace panes"] button:has-text("Terminal")');
        await expectScreen(page, '[data-terminal-deck]');
        const create = await page.evaluate<boolean>(`[...document.querySelectorAll('[data-terminal-deck] button')].some(b => /New terminal|Create terminal/.test(b.textContent + (b.getAttribute('aria-label') ?? '')))`);
        if (create) await page.click('[data-terminal-deck] button:has-text("New terminal"), [data-terminal-deck] [aria-label="Create terminal"]');
        await expectScreen(page, '.kt-webterm__connection[data-state="live"]', 30_000);
        return { value: undefined, evidence: `a shell terminal opened and went live at ${sessionUrl}` };
      });
      await captureScreens(page, journey, '09-terminal');

      // Secrets: names only.
      const secretName = 'E2E_SECRET';
      await step(journey, 'add-secret', async () => {
        await page.goto(`${product.origin.origin}/d/${daemonId}/settings#daemons`, { waitUntil: 'networkidle', timeout: 30_000 });
        await expectScreen(page, '[data-daemon-panel="secrets"], [data-daemon-panel-trigger]');
        if (await page.evaluate<boolean>(`document.querySelector('[data-daemon-panel="secrets"]') !== null`)) await page.click('[data-daemon-panel="secrets"]');
        await expectScreen(page, '[data-testid="secrets-card"]');
        await page.fill('form[aria-label="Add or replace a secret"] input:not([type="password"])', secretName);
        await page.fill('form[aria-label="Add or replace a secret"] input[type="password"]', 'fake-e2e-secret-value');
        await answerPasswordIfAsked(page);
        await page.click('form[aria-label="Add or replace a secret"] button:has-text("Save")');
        await expectScreen(page, `li[data-secret="${secretName}"]`);
        const listed = await asOwner(environment, 'GET', '/v1/secrets');
        if (JSON.stringify(listed.body).includes('fake-e2e-secret-value')) throw new Error('the secrets list returned a VALUE');
        const pageText = await page.evaluate<string>('document.body.textContent');
        if (pageText.includes('fake-e2e-secret-value')) throw new Error('the page shows the secret VALUE');
        return { value: undefined, evidence: `${secretName} is listed by name; neither the route nor the page shows the value` };
      });
      await captureScreens(page, journey, '10-secrets');

      await step(journey, 'change-setting', async () => {
        await page.goto(`${product.origin.origin}/d/${daemonId}/settings#text-size`, { waitUntil: 'networkidle', timeout: 30_000 });
        await expectScreen(page, 'input[name="text-scale"][value="large"]');
        await page.click('label:has(input[name="text-scale"][value="large"])');
        await waitUntil(page, `document.documentElement.getAttribute('data-text-scale') === 'large'`, 10_000);
        return { value: undefined, evidence: 'text size Large applied (<html data-text-scale="large">)' };
      });
      await captureScreens(page, journey, '11-settings');

      // The audit log (#461) records the session, terminal, secret and setting.
      const audit = await asOwner(environment, 'GET', '/v1/audit');
      if (audit.status === 404) {
        await recordStep({ journey, step: 'audit-log', status: 'SKIP', evidence: 'this build has no /v1/audit — the audit log (#461) is not merged' });
      } else {
        await recordStep({ journey, step: 'audit-log', status: 'FAIL', evidence: `audit present (${JSON.stringify(audit.body).slice(0, 300)}); assertions written once #461 lands` });
      }
    });
  }, 600_000);
});
