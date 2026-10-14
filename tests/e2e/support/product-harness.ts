/**
 * The product as a person meets it: a compiled daemon, the real bundle, a real Chrome that can hold
 * a passkey, and a record of every screen it showed.
 *
 * `relay-harness.ts` owns the four external parts a relayed pairing needs (rendezvous, directory,
 * PWA origin, sinkhole). This module owns what the FULL product journeys add on top of them:
 *
 *   - one way to boot the compiled `fyd` against the fixture's isolated home, with or without a
 *     rendezvous, so every journey starts from the same first boot;
 *   - a browser whose context and CDP session are reachable, because a passkey is registered
 *     against a CDP VIRTUAL AUTHENTICATOR rather than seeded around, and a phone-width capture needs
 *     the viewport and colour scheme under the harness's control;
 *   - a screenshot sweep that also MEASURES the margins it captures, so "the layout is fine" is an
 *     assertion rather than a judgement made by looking at a PNG later;
 *   - a journey report every file appends to, which is what `e2e-report.md` is built from.
 *
 * Nothing here reaches a real account, a real home or the network beyond loopback: the daemon runs
 * in the fixture's `FY_HOME`, the directory origin is the loopback stub, and the browser is
 * launched with no profile.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { E2eEnvironment } from '../fixture.ts';
import {
  chromeExecutable,
  closeChromeBounded,
  type HarnessTeardown,
  launchChromiumWithRetry,
  resolvePlaywright,
  evidenceScreenshot,
  stdioPipeFailures,
} from './relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');

/**
 * Where the full-product journeys put their evidence: outside the repository, never committed.
 * `scripts/ci/e2e.sh` points both at the directory CI uploads; a local run defaults to the temp dir.
 */
export const EVIDENCE_ROOT = process.env.FY_E2E_EVIDENCE_ROOT ?? join(tmpdir(), 'fy-e2e-evidence');
/** One JSON object per line, so the journey report can be rebuilt from it at any time. */
const JOURNEY_LOG = process.env.FY_E2E_JOURNEY_LOG ?? join(tmpdir(), 'fy-e2e-evidence', 'journeys.jsonl');

// ─── compiled artifacts ──────────────────────────────────────────────────────────────────────

function hostTarget(): string {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64-baseline';
  return `${platform}-${architecture}`;
}

/** The compiled daemon, named the way `scripts/release/compile.sh` names it. */
function compiledDaemon(): string {
  const explicit = process.env.FYD_BIN;
  if (explicit !== undefined && explicit !== '') return resolve(REPOSITORY_ROOT, explicit);
  return join(REPOSITORY_ROOT, 'dist', 'bin', `fyd-${hostTarget()}`);
}

// ─── the daemon ──────────────────────────────────────────────────────────────────────────────

export interface DaemonConfigInput {
  readonly bindPort: number;
  /** The address the daemon advertises in a pairing link. Defaults to its own bind address. */
  readonly publicUrl?: string;
  /** Every origin a browser may call from — the PWA origin this run serves. */
  readonly appOrigins: readonly string[];
  /** `false` writes the operator's explicit "no rendezvous" block; omitted leaves discovery on. */
  readonly relay?: false;
  /** Anything else a journey needs in the document, merged last. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * The daemon document, written OUTSIDE the state home and read with `--config`.
 *
 * A `config/daemon.json` placed into an empty `FY_HOME` makes the home "non-empty with no layout
 * marker" and the daemon refuses to open it — see the relay journey's `daemonDocument`, which this
 * mirrors so both tiers boot the same way.
 */
export async function writeDaemonConfig(path: string, input: DaemonConfigInput): Promise<string> {
  const bound = `http://127.0.0.1:${String(input.bindPort)}`;
  const document = {
    publicUrl: input.publicUrl ?? bound,
    corsOrigins: [...input.appOrigins],
    carriers: [
      { kind: 'bind', host: '127.0.0.1', port: input.bindPort },
      ...(input.relay === false ? [{ kind: 'relay', source: 'discovery', enabled: false }] : []),
    ],
    ...input.extra,
  };
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

export interface BootOptions {
  readonly configPath: string;
  /** The stub directory origin. Always set: the default is the production origin, never dialled here. */
  readonly directoryOrigin: string;
  readonly env?: Readonly<Record<string, string>>;
}

export async function bootDaemon(environment: E2eEnvironment, options: BootOptions): Promise<void> {
  await environment.startDaemon({
    command: [compiledDaemon(), '--config', options.configPath],
    readyUrl: environment.httpUrl('/v1/health'),
    timeoutMs: 30_000,
    useDaemonPrivateTmux: true,
    env: { FY_RELAY_DIRECTORY_ORIGIN: options.directoryOrigin, ...options.env },
  });
}

/** The owner's admin token: the credential of somebody AT the machine. */
export async function adminToken(environment: E2eEnvironment): Promise<string> {
  return (await readFile(join(environment.paths.fyHome, 'api-token'), 'utf8')).trim();
}

export interface DaemonCall {
  readonly status: number;
  readonly body: unknown;
}

/** One call as the owner at the machine. Never used for what a DEVICE is supposed to be refused. */
export async function asOwner(
  environment: E2eEnvironment,
  method: string,
  path: string,
  body?: unknown,
): Promise<DaemonCall> {
  const response = await fetch(environment.httpUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${await adminToken(environment)}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON; the raw text is the answer.
  }
  return { status: response.status, body: parsed };
}

// ─── the browser ─────────────────────────────────────────────────────────────────────────────

/** The slice of Playwright the product journeys drive. Hand-written for the reason `BrowserPage` is. */
export interface ProductPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  evaluate<T>(expression: string): Promise<T>;
  screenshot(options: { path: string; fullPage?: boolean; timeout?: number }): Promise<unknown>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(options: { colorScheme?: 'light' | 'dark' | null }): Promise<void>;
  reload(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  on(event: string, handler: (payload: unknown) => void): void;
  close(): Promise<void>;
}

interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

interface ProductContext {
  addInitScript(script: string): Promise<void>;
  newPage(): Promise<ProductPage>;
  newCDPSession(page: ProductPage): Promise<CdpSession>;
  grantPermissions(permissions: readonly string[], options?: { origin?: string }): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  route(url: string | RegExp, handler: (route: { abort(code?: string): Promise<void> }) => unknown): Promise<void>;
  close(): Promise<void>;
}

interface ProductBrowserLauncher {
  launch(options: { executablePath: string; headless: boolean; args: string[]; timeout?: number }): Promise<{
    newContext(options?: Record<string, unknown>): Promise<ProductContext>;
    close(): Promise<void>;
  }>;
}

export interface ProductBrowser {
  readonly context: ProductContext;
  readonly page: ProductPage;
  readonly console: readonly string[];
  readonly pageErrors: readonly string[];
  /** A page-level CDP session, opened lazily, shared by the authenticator and anything else. */
  cdp(): Promise<CdpSession>;
  stop(): Promise<void>;
}

const DESKTOP = { width: 1_280, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

/**
 * Chrome with no profile, every page error kept, loopback permitted.
 *
 * `local-network-access` is granted before the first navigation for the reason
 * `relay-harness.ts#launchChrome` records at length: a headless Chrome denies it silently and the
 * daemon then receives nothing, which reads as a routing defect.
 */
export async function launchProductBrowser(
  teardown: HarnessTeardown,
  options: { readonly viewport?: { width: number; height: number }; readonly userAgent?: string } = {},
): Promise<ProductBrowser> {
  const module = (await import(resolvePlaywright())) as { chromium: ProductBrowserLauncher };
  const browser = await launchChromiumWithRetry(() =>
    module.chromium.launch({
      executablePath: chromeExecutable(),
      headless: true,
      // Chrome starts in about two seconds; a launch that has not finished in twenty never will (see launchChromiumWithRetry).
      timeout: 20_000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }),
  );
  const close = (): Promise<void> => closeChromeBounded(() => browser.close());
  teardown.add('product chrome', close);
  const context = await browser.newContext({
    viewport: options.viewport ?? DESKTOP,
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  });
  await context.grantPermissions(['local-network-access']).catch(() => undefined);
  const page = await context.newPage();
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', payload => consoleLines.push(String((payload as { text(): string }).text())));
  page.on('pageerror', payload => pageErrors.push(String(payload)));
  // How a browser dies is evidence: a renderer crash, a lost connection, or a pipe the stdio guard saw
  // fail are three different defects, and "Target page, context or browser has been closed" names none.
  page.on('crash', () => {
    void recordStep({
      journey: 'harness',
      step: 'chrome:page-crashed',
      status: 'FLAG',
      evidence: `the renderer crashed at ${new Date().toISOString()}`,
    });
  });
  (browser as unknown as { on?: (event: string, handler: () => void) => void }).on?.('disconnected', () => {
    void recordStep({
      journey: 'harness',
      step: 'chrome:disconnected',
      status: 'FLAG',
      evidence: `the browser connection closed at ${new Date().toISOString()}; stdio guard caught: ${stdioPipeFailures().join(' | ') || 'nothing'}`,
    });
  });
  let session: Promise<CdpSession> | undefined;
  return {
    context,
    page,
    console: consoleLines,
    pageErrors,
    cdp: () => {
      session ??= context.newCDPSession(page);
      return session;
    },
    stop: close,
  };
}

export interface VirtualAuthenticator {
  readonly authenticatorId: string;
  /** How many credentials the authenticator holds — a registration is proved by this moving. */
  credentials(): Promise<number>;
}

/**
 * A platform authenticator with user verification, driven by Chrome itself.
 *
 * `isUserVerified: true` and `automaticPresenceSimulation: true` make every ceremony succeed the way
 * a fingerprint would — the browser still runs the real WebAuthn code path, the daemon still verifies
 * a real signature, and nothing about the unlock is short-circuited. Seeding the unlock "off" instead
 * would prove only that a switch exists.
 */
export async function addVirtualAuthenticator(browser: ProductBrowser): Promise<VirtualAuthenticator> {
  const cdp = await browser.cdp();
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send<{ authenticatorId: string }>('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    authenticatorId,
    credentials: async () =>
      (await cdp.send<{ credentials: unknown[] }>('WebAuthn.getCredentials', { authenticatorId })).credentials.length,
  };
}

// ─── screens and margins ─────────────────────────────────────────────────────────────────────

export interface LayoutFinding {
  readonly shot: string;
  readonly problem: string;
}

/**
 * What a reader would call a margin bug, measured.
 *
 * Three checks, each a defect a screenshot hides until somebody squints: the document scrolls
 * sideways; a visible element's box crosses the viewport's right edge; and a visible element's text
 * box is clipped by its own box (text-overflow without an ellipsis reads as a cut word). The selector
 * list for the third is deliberately narrow — buttons, headings and labels — because scroll lists
 * legitimately overflow.
 */
const LAYOUT_PROBE = `(() => {
  const width = document.documentElement.clientWidth;
  const problems = [];
  if (document.documentElement.scrollWidth > width + 1)
    problems.push('the document scrolls sideways: ' + document.documentElement.scrollWidth + 'px wide in a ' + width + 'px viewport');
  const describe = node => node.tagName.toLowerCase() + [...node.attributes].filter(a => a.name.startsWith('data-') || a.name === 'aria-label').slice(0, 2).map(a => '[' + a.name + (a.value ? '=' + a.value.slice(0, 30) : '') + ']').join('') + ' "' + (node.textContent || '').trim().slice(0, 40) + '"';
  const visible = node => { const s = getComputedStyle(node); const r = node.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0 && !node.closest('[aria-hidden="true"]') && !node.classList.contains('sr-only'); };
  const clippedBy = node => { for (let p = node.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.overflowX !== 'visible') return p; } return null; };
  let edges = 0;
  for (const node of document.querySelectorAll('body *')) {
    if (!visible(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.right > width + 1 && r.left < width && clippedBy(node) === null && edges < 5) { edges++; problems.push('crosses the right edge by ' + Math.round(r.right - width) + 'px: ' + describe(node)); }
    if (r.left < -1 && r.right > 0 && clippedBy(node) === null && edges < 5) { edges++; problems.push('crosses the left edge by ' + Math.round(-r.left) + 'px: ' + describe(node)); }
  }
  let clipped = 0;
  for (const node of document.querySelectorAll('button, h1, h2, h3, label, [role="tab"]')) {
    if (!visible(node) || clipped >= 5) continue;
    if (node.scrollWidth > node.clientWidth + 2 && getComputedStyle(node).textOverflow !== 'ellipsis') { clipped++; problems.push('text is clipped inside its own box: ' + describe(node)); }
  }
  return problems;
})()`;

/**
 * Capture one screen at phone and desktop width, light and dark, and measure each.
 *
 * The same page is resized rather than a second context opened: a second context is a second
 * DEVICE, with its own key and its own pairing, and the screens worth capturing are the ones this
 * device reached. The cost is honest and recorded on the report: the app's device detection reads the
 * user agent, so a 390px capture of a FLOW that branches on phone-vs-desktop (onboarding) shows the
 * desktop branch at phone width. Margins, wrapping and overflow — what this sweep is for — are width
 * properties and are measured correctly.
 */
/** Screens where the system theme did not follow a live OS switch. Read by the report. */
const themeLag = new Set<string>();

export async function captureScreens(
  page: ProductPage,
  journey: string,
  screen: string,
): Promise<{ readonly paths: readonly string[]; readonly findings: readonly LayoutFinding[] }> {
  const directory = join(EVIDENCE_ROOT, journey);
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  const findings: LayoutFinding[] = [];
  for (const [label, size] of [
    ['phone', PHONE],
    ['desktop', DESKTOP],
  ] as const) {
    await page.setViewportSize(size);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // Two frames: one for the media query to apply, one for any layout it caused.
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      /**
       * A `system` theme follows the OS LIVE only where `useTheme()` is mounted — the theme toggle and
       * Settings (`packages/pwa/src/hooks/use-theme.ts`). Elsewhere (phone layouts, the setup guide)
       * the attribute keeps whatever `pre-paint.js` chose at load. That is recorded as a finding, and
       * the attribute is then set to what a reload would choose, so the capture still shows the scheme
       * it is named after.
       */
      const followed = await page.evaluate<{ theme: string | null; stored: string | null }>(
        `({ theme: document.documentElement.getAttribute('data-theme'), stored: localStorage.getItem('fy-theme-v1') })`,
      );
      const systemMode = followed.stored === null || followed.stored.includes('"system"');
      if (systemMode && followed.theme !== null && !followed.theme.endsWith(`-${scheme}`)) {
        themeLag.add(`${journey}/${screen}@${label}`);
        await page.evaluate(
          `document.documentElement.setAttribute('data-theme', ${JSON.stringify(followed.theme.replace(/-(light|dark)$/u, `-${scheme}`))})`,
        );
        await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      }
      const path = join(directory, `${screen}-${label}-${scheme}.png`);
      const missed = await evidenceScreenshot(page, path);
      if (missed !== null)
        await recordStep({
          journey,
          step: `capture:${screen}`,
          status: 'FLAG',
          evidence: `no screenshot at ${label} ${scheme}: ${missed}`,
        });
      paths.push(path);
      if (scheme === 'light') {
        for (const problem of await page.evaluate<string[]>(LAYOUT_PROBE)) findings.push({ shot: path, problem });
      }
    }
  }
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: null });
  if ([...themeLag].some(entry => entry.startsWith(`${journey}/${screen}@`)))
    await recordStep({
      journey,
      step: `theme-follows-os:${screen}`,
      status: 'FLAG',
      evidence: `a system theme did not follow a live OS light/dark switch on this screen (${[...themeLag].filter(entry => entry.startsWith(`${journey}/${screen}@`)).join(', ')})`,
      bug: 'packages/pwa/src/hooks/use-theme.ts:72-79 — the live prefers-color-scheme listener lives in useTheme(), mounted only by theme-toggle.tsx:327 and settings-page.tsx:340; minor',
    });
  if (findings.length > 0)
    await recordStep({
      journey,
      step: `layout:${screen}`,
      status: 'FLAG',
      evidence: findings.map(finding => `${finding.problem} (${finding.shot})`).join('; '),
    });
  return { paths, findings };
}

// ─── the journey log ─────────────────────────────────────────────────────────────────────────

export interface JourneyStep {
  readonly journey: string;
  readonly step: string;
  readonly status: 'PASS' | 'FAIL' | 'FLAG' | 'SKIP' | 'KNOWN';
  readonly evidence: string;
  /** Present on FAIL/FLAG when the cause is the product: file:line, repro, severity. */
  readonly bug?: string;
}

export async function recordStep(step: JourneyStep): Promise<void> {
  await mkdir(join(JOURNEY_LOG, '..'), { recursive: true });
  await appendFile(JOURNEY_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...step })}\n`, 'utf8');
}

/**
 * Run one named step: PASS with its evidence, or FAIL with the error, and rethrow so the test fails.
 *
 * Every product journey is a sequence of these, so the report says which step broke and what the
 * screen showed rather than a stack trace about a selector.
 */
export async function step<T>(
  journey: string,
  name: string,
  body: () => Promise<{ value: T; evidence: string }>,
): Promise<T> {
  try {
    const { value, evidence } = await body();
    await recordStep({ journey, step: name, status: 'PASS', evidence });
    return value;
  } catch (error) {
    await recordStep({
      journey,
      step: name,
      status: 'FAIL',
      evidence: String((error as Error).message ?? error).slice(0, 1_500),
    });
    throw error;
  }
}

// ─── a whole product, from an empty machine ──────────────────────────────────────────────────

export const OPERATOR_PASSWORD = 'correct horse battery e2e';
const PAIRING_LINK = /https?:\/\/\S*#v\d;\S+/u;

export interface FakeTools {
  readonly directory: string;
  readonly claude: string;
  readonly codex: string;
  readonly claudeLog: string;
  readonly codexLog: string;
}

/**
 * A machine that HAS Claude and Codex installed — both fakes — and a Claude login in the temp HOME.
 *
 * The daemon locates a harness through `FY_CLAUDE_BIN`/`FY_CODEX_BIN`, then PATH. Both are pinned
 * here, because the probe that built this module found the host's REAL `codex` on PATH: without the
 * pin, "Sign in now" would have launched the owner's codex. The directory is also prepended to this
 * process's PATH, which is what the daemon inherits under `useDaemonPrivateTmux`, because a
 * generated runtime wrapper execs `claude` by NAME.
 */
export async function installFakeTools(environment: E2eEnvironment): Promise<FakeTools> {
  const directory = join(environment.paths.root, 'tools');
  await mkdir(directory, { recursive: true });
  const claude = join(directory, 'claude');
  const codex = join(directory, 'codex');
  await writeFile(claude, await readFile(join(REPOSITORY_ROOT, 'scripts', 'test', 'fake-claude-tui.sh'), 'utf8'), {
    mode: 0o755,
  });
  await writeFile(codex, await readFile(join(REPOSITORY_ROOT, 'scripts', 'test', 'fake-codex-login.ts'), 'utf8'), {
    mode: 0o755,
  });
  const claudeHome = join(environment.paths.home, '.claude');
  await mkdir(claudeHome, { recursive: true });
  // The shape the scan reads as "signed in". Fake values; nothing here can reach a real account.
  await writeFile(
    join(claudeHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-e2e-access',
        refreshToken: 'fake-e2e-refresh',
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    'utf8',
  );
  if (!(process.env.PATH ?? '').split(':').includes(directory))
    process.env.PATH = `${directory}:${process.env.PATH ?? ''}`;
  return {
    directory,
    claude,
    codex,
    claudeLog: join(environment.paths.root, 'fake-claude.log'),
    codexLog: join(environment.paths.root, 'fake-codex.log'),
  };
}

export function fakeToolEnvironment(tools: FakeTools): Record<string, string> {
  return {
    FY_CLAUDE_BIN: tools.claude,
    FY_CODEX_BIN: tools.codex,
    FY_E2E_FAKE_CLAUDE_LOG: tools.claudeLog,
    FY_E2E_FAKE_CODEX_LOG: tools.codexLog,
    // `fy daemon start` gives fyd no locale and tmux then mangles its own TAB-separated answers;
    // a direct boot inherits one, so pin it rather than depend on the runner's shell.
    LANG: 'C.UTF-8',
  };
}

/**
 * The operator password, set the way a person at the machine sets it.
 *
 * On main a device cannot be paired until one exists (`pairing_needs_operator_password`). Under the
 * unlock model (#464) the route is gone; a 404 is therefore "this build has no operator password",
 * not a failure, and the caller learns which model it is driving from the answer.
 */
export async function ensureOperatorPassword(environment: E2eEnvironment): Promise<'set' | 'no-password-model'> {
  const answer = await asOwner(environment, 'PUT', '/v1/grants/password', { password: OPERATOR_PASSWORD });
  if (answer.status === 404) return 'no-password-model';
  if (answer.status >= 300)
    throw new Error(`setting the operator password answered ${String(answer.status)}: ${JSON.stringify(answer.body)}`);
  return 'set';
}

export interface MintedLink {
  readonly url: string;
  readonly fragment: string;
  readonly screen: string;
}

/** `fy pair --no-wait`, scraped, and re-hosted on the origin this run serves. */
export async function mintPairingLink(
  environment: E2eEnvironment,
  appOrigin: string,
  args: readonly string[] = [],
): Promise<MintedLink> {
  const minted = await environment.runFy(['pair', '--no-wait', ...args], { FY_URL: environment.httpUrl() });
  const screen = `${minted.out}\n${minted.err}`;
  const link = PAIRING_LINK.exec(screen)?.[0];
  if (link === undefined)
    throw new Error(`\`fy pair --no-wait\` printed no link (exit ${String(minted.code)}):\n${screen.trim()}`);
  const fragment = link.slice(link.indexOf('#') + 1);
  return { url: `${appOrigin}/pair#${fragment}`, fragment, screen };
}

/**
 * Open the link, confirm, and wait for the screen to settle the way the relay journey learned it does:
 * a standalone `paired`, or the embedded frame unmounting as the setup guide moves on.
 */
export async function confirmPairing(page: ProductPage, url: string): Promise<'paired' | 'unmounted'> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector('[data-pairing-stage="confirm"]', { timeout: 20_000 }).catch(async () => {
    const shot = join(EVIDENCE_ROOT, 'pairing-never-confirmed-' + String(Date.now()) + '.png');
    await mkdir(EVIDENCE_ROOT, { recursive: true });
    await page.screenshot({ path: shot });
    const seen = await page.evaluate<string>(
      `JSON.stringify({ href: location.href, route: document.querySelector('p[data-route]')?.getAttribute('data-route') ?? null, stage: document.querySelector('[data-pairing-stage]')?.getAttribute('data-pairing-stage') ?? null, onboarding: document.querySelector('[data-onboarding-screen]')?.getAttribute('data-onboarding-screen') ?? null, text: (document.body.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 400) })`,
    );
    throw new Error(`the pairing link never reached the confirm screen (${shot}): ${seen}`);
  });
  await page.click('[data-pair-confirm]', { timeout: 10_000 });
  const settled = await Promise.race([
    page.waitForSelector('[data-pairing-stage="paired"]', { timeout: 45_000 }).then(() => 'paired' as const),
    page
      .waitForSelector('[data-pairing-stage]', { state: 'detached', timeout: 45_000 })
      .then(() => 'unmounted' as const),
  ]).catch(() => undefined);
  if (settled === undefined) {
    const stage = await page.evaluate<string | null>(
      `document.querySelector('[data-pairing-stage]')?.getAttribute('data-pairing-stage') ?? null`,
    );
    const failure = await page.evaluate<string | null>(
      `(document.querySelector('[data-pairing-failure]')?.textContent ?? '').trim().slice(0, 300) || null`,
    );
    throw new Error(`pairing never settled: stage=${String(stage)} failure=${String(failure)}`);
  }
  return settled;
}

/** Where the URL says the app is: `p[data-route]`, e.g. `settings:"fy_daemon_…"`. */
export async function currentRoute(page: ProductPage): Promise<string | null> {
  return page.evaluate<string | null>(`document.querySelector('p[data-route]')?.getAttribute('data-route') ?? null`);
}

/** Visible text of a selector, or null — never waits, so it can be used in a failure message. */
export async function textNow(page: ProductPage, selector: string): Promise<string | null> {
  return page.evaluate<string | null>(
    `(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n === null ? null : (n.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 400); })()`,
  );
}

/**
 * If the screen is asking for the operator password for this one change, give it.
 *
 * On main a device change can be held behind the password (`[data-change-password]`). Under the
 * unlock model it never is; the absent field is then simply not filled.
 */
export async function answerPasswordIfAsked(page: ProductPage): Promise<boolean> {
  const asked = await page.evaluate<boolean>(
    `document.querySelector('[data-change-password] input, input[data-change-password]') !== null`,
  );
  if (!asked) return false;
  await page.fill('[data-change-password] input, input[data-change-password]', OPERATOR_PASSWORD);
  return true;
}

/**
 * Poll an expression until it is truthy.
 *
 * NOT `page.waitForFunction(string)`: that evaluates the string with `new Function` INSIDE the page,
 * which the app's real Content-Security-Policy (no `unsafe-eval`) refuses. `evaluate` goes through
 * the DevTools protocol instead, which a page CSP does not govern — and the CSP is part of what these
 * journeys prove, so it is never bypassed.
 */
export async function waitUntil(
  page: ProductPage,
  expression: string,
  timeoutMs = 20_000,
  what = expression,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return;
    await Bun.sleep(150);
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what} at ${page.url()}`);
}

/** Soft failures per journey: recorded and reported, and the journey goes on to its later steps. */
const softFailures = new Map<string, string[]>();

/**
 * {@link step}, but a failure is RECORDED rather than thrown, so one product bug does not hide every
 * step after it. The journey must call {@link assertNoSoftFailures} last, so the test still fails.
 */
export async function softStep(
  journey: string,
  name: string,
  body: () => Promise<{ value: unknown; evidence: string }>,
  bug?: string,
  /**
   * A KNOWN, open product bug, matched by its own failure message: while it reproduces the step is
   * recorded `KNOWN` (with `bug`) and does not fail the run, so an advisory CI job can stay green on
   * the main line while the bug is still on the report. The moment the step PASSES, it fails the run
   * with "remove the marker" — a known-bug marker can never outlive its bug. Any OTHER failure of the
   * same step is an ordinary failure.
   */
  knownWhen?: RegExp,
): Promise<boolean> {
  try {
    const { evidence } = await body();
    await recordStep({ journey, step: name, status: 'PASS', evidence });
    if (knownWhen !== undefined)
      softFailures.set(journey, [
        ...(softFailures.get(journey) ?? []),
        `${name}: the known bug no longer reproduces — remove its knownWhen marker (${bug ?? 'no bug named'})`,
      ]);
    return true;
  } catch (error) {
    const message = String((error as Error).message ?? error).slice(0, 1_500);
    if (knownWhen?.test(message) === true) {
      await recordStep({
        journey,
        step: name,
        status: 'KNOWN',
        evidence: message,
        ...(bug === undefined ? {} : { bug }),
      });
      return false;
    }
    await recordStep({ journey, step: name, status: 'FAIL', evidence: message, ...(bug === undefined ? {} : { bug }) });
    softFailures.set(journey, [...(softFailures.get(journey) ?? []), `${name}: ${message}`]);
    return false;
  }
}

export function assertNoSoftFailures(journey: string): void {
  const failures = softFailures.get(journey) ?? [];
  if (failures.length > 0)
    throw new Error(`${journey} — ${String(failures.length)} step(s) failed:\n${failures.join('\n')}`);
}

/**
 * After the daemon has stopped: end its private tmux server, then find anything else still running
 * from this journey's root — and say so, because a child that outlives its daemon is a product
 * finding (the first one found was a `codex login` holding localhost:1455 after fyd's SIGTERM).
 *
 * The private tmux server is EXPECTED to outlive fyd: sessions survive a daemon restart by design, so
 * it is ended here without being reported. Only this run's root is ever matched, so nothing belonging
 * to another journey, teammate or the owner can be touched.
 */
export async function reapLeftovers(environment: E2eEnvironment, journey: string): Promise<readonly string[]> {
  const tmux = Bun.which('tmux');
  if (tmux !== null) {
    Bun.spawnSync([tmux, '-S', join(environment.paths.fyHome, 'tmux.sock'), 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  }
  await Bun.sleep(300);
  // Synchronous: see `closeChromeBounded` — an async spawn can lose its epoll registration under load.
  const listed = Bun.spawnSync(['pgrep', '-af', environment.paths.root], { stdout: 'pipe', stderr: 'ignore' });
  const lines = listed.stdout
    .toString()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.includes('pgrep') && !/\btmux\b/u.test(line))
    // The harness's own processes (the rendezvous, the PWA build) name this root in their arguments
    // and are ended by the journey teardown, not by the daemon.
    .filter(line => !line.includes('/scripts/test/rendezvous-process.ts'));
  if (lines.length > 0) {
    await recordStep({
      journey,
      step: 'no-orphans-after-daemon-stop',
      status: 'FLAG',
      evidence: lines.map(line => line.slice(0, 200)).join(' | '),
      bug: 'a child of fyd keeps running after fyd stops (SIGTERM): it is re-parented to init and keeps whatever it holds. Seen: a codex login child still bound to localhost:1455, which makes the next Codex sign-in on that machine fail. MAJOR',
    });
    for (const line of lines) {
      const pid = Number(line.split(' ')[0]);
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  }
  return lines;
}
