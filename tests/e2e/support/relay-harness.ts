/**
 * The four external things a relayed first pairing needs, each a real one.
 *
 * This module owns the pieces `tests/e2e/fixture.ts` has no opinion about — a rendezvous process, an
 * origin serving the REAL built PWA bundle, a direct address that demonstrably refuses, and a real
 * Chrome. The fixture still owns the isolated `HOME`/`FY_HOME`, the dedicated tmux server, the
 * compiled binary and the cleanup contract; nothing here bypasses it.
 *
 * Everything started here is registered on a {@link HarnessTeardown} so a failing assertion, a
 * timeout and an interrupt all release the same processes, sockets, ports and browser.
 *
 * ── WHY AN UNREACHABLE DIRECT ADDRESS IS A COMPONENT ──────────────────────────────────────────
 *
 * The proof is worthless if the browser could have succeeded over loopback. The daemon and Chrome
 * are on one machine here, so "the direct address is unreachable" has to be ARRANGED rather than
 * assumed. {@link startDirectSinkhole} is that arrangement: a real TCP listener on a real loopback
 * port that accepts the connection, counts it, and destroys it without speaking HTTP. That gives
 * two things a firewall rule could not:
 *
 *   - the browser's direct attempt fails at TRANSPORT, which is the only failure the carrier walk
 *     advances on (§13: any HTTP answer stops the walk), and
 *   - the attempt is COUNTED, so the harness can assert the browser really did try direct first
 *     rather than assert the absence of something it never attempted.
 *
 * A closed port would also fail, but it would prove only that nothing answered; a counter proves
 * the browser knocked.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { assertNoLiveStatePath } from '../fixture.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');

/**
 * The published site's own `connect-src`, served byte-for-byte from `packages/pwa/public/_headers`.
 *
 * Read rather than copied: a harness that shipped its own permissive policy would prove the app
 * works under a policy nobody deploys, and the loopback allowances this journey depends on are
 * exactly the clauses most likely to be tightened by someone who does not know a test needs them.
 */
const HEADERS_FILE = join(REPOSITORY_ROOT, 'packages', 'pwa', 'public', '_headers');

export interface HarnessTeardown {
  add(label: string, close: () => Promise<void> | void): void;
  closeAll(): Promise<void>;
}

export function harnessTeardown(): HarnessTeardown {
  const entries: { readonly label: string; readonly close: () => Promise<void> | void }[] = [];
  return {
    add: (label, close) => {
      entries.push({ label, close });
    },
    closeAll: async () => {
      const failures: unknown[] = [];
      // Reverse order: the browser must go before the origin it is pointed at, and the daemon
      // before the rendezvous it is dialling, or shutdown produces errors that read as defects.
      for (const entry of entries.reverse()) {
        try {
          await entry.close();
        } catch (error) {
          failures.push(new Error(`harness teardown failed: ${entry.label}`, { cause: error }));
        }
      }
      entries.length = 0;
      if (failures.length !== 0) throw new AggregateError(failures, 'relay harness teardown failed');
    },
  };
}

// ─── the rendezvous ───────────────────────────────────────────────────────────────────────────

export interface ObservedFrame {
  readonly at: number;
  readonly direction: 'to-rendezvous' | 'from-rendezvous';
  readonly role: 'daemon' | 'client' | 'unknown';
  readonly kind: 'binary' | 'text';
  readonly bytes: number;
  readonly base64: string;
}

export interface RendezvousProcess {
  /** `ws://127.0.0.1:<port>` — a legal relay address only because it is loopback (§13). */
  readonly relayUrl: string;
  readonly httpOrigin: string;
  readonly observationsPath: string;
  /** Install this run's daemon fingerprint; a self-hosted relay serves nobody until one is listed. */
  allow(daemonId: string): Promise<void>;
  /** What the rendezvous is holding right now, by role. The honest "the daemon has claimed it". */
  sockets(): Promise<readonly { readonly rendezvous: string; readonly roles: readonly string[] }[]>;
  /**
   * Every arrival this rendezvous has seen, in order, admitted or refused.
   *
   * Durable rather than a live census: a §14 pairing session closes with `4440` the moment its
   * sealed outcome is sent, so polling for a connected client reports the same emptiness whether
   * the pairing crossed this relay or never happened.
   */
  arrivals(): Promise<readonly { readonly role: 'daemon' | 'client'; readonly daemonId: string }[]>;
  /** The daemon half of {@link arrivals} — how the harness learns this run's fingerprint. */
  dialled(): Promise<readonly string[]>;
  /** Every frame this rendezvous handled, in both directions, in order. */
  observations(): Promise<readonly ObservedFrame[]>;
  stop(): Promise<void>;
}

export async function startRendezvous(root: string, teardown: HarnessTeardown): Promise<RendezvousProcess> {
  const observationsPath = await assertNoLiveStatePath(join(root, 'rendezvous-frames.jsonl'), 'relay observations');
  await writeFile(observationsPath, '', 'utf8');

  // `scripts/test/` is where this repository keeps executables that are SPAWNED by path rather than
  // imported — `fake-harness.ts`, `fake-daemon.ts`, `bootstrap-only-fyd.ts` — and `knip.json` makes
  // that directory an entry point for exactly that reason. A spawned script under
  // `tests/e2e/support/` (imported modules) has no importer and is correctly reported as dead.
  const script = join(REPOSITORY_ROOT, 'scripts', 'test', 'rendezvous-process.ts');
  const child = spawn(process.execPath, [script, '--observations', observationsPath], {
    cwd: REPOSITORY_ROOT,
    // The rendezvous inherits nothing from the isolated home: it is a THIRD PARTY to this journey
    // and giving it `FY_HOME` would let a defect there look like a relay that could read state.
    env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise<void>(settle => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle();
      }, 3_000);
      child.once('close', () => {
        clearTimeout(timer);
        settle();
      });
    });
  };
  teardown.add('rendezvous process', stop);

  const ready = await new Promise<{ readonly port: number; readonly origin: string }>((settle, fail) => {
    let stdout = '';
    const timer = setTimeout(() => fail(new Error(`rendezvous process never reported ready\n${stderr}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      const line = stdout.split('\n').find(candidate => candidate.trim().startsWith('{'));
      if (line === undefined) return;
      clearTimeout(timer);
      settle(JSON.parse(line) as { port: number; origin: string });
    });
    child.once('close', code => {
      clearTimeout(timer);
      fail(new Error(`rendezvous process exited early (code ${String(code)})\n${stderr}`));
    });
  });

  const httpOrigin = `http://127.0.0.1:${String(ready.port)}`;
  return {
    relayUrl: `ws://127.0.0.1:${String(ready.port)}`,
    httpOrigin,
    observationsPath,
    allow: async daemonId => {
      const response = await fetch(`${httpOrigin}/__harness/allow`, { method: 'POST', body: daemonId });
      if (!response.ok) throw new Error(`rendezvous refused the fingerprint allowlist: ${String(response.status)}`);
    },
    sockets: async () => {
      const response = await fetch(`${httpOrigin}/__harness/sockets`);
      const body = (await response.json()) as {
        rendezvous: { rendezvous: string; sockets: number; roles: string[] }[];
      };
      return body.rendezvous;
    },
    arrivals: async () => {
      const response = await fetch(`${httpOrigin}/__harness/arrivals`);
      return ((await response.json()) as { arrivals: { role: 'daemon' | 'client'; daemonId: string }[] }).arrivals;
    },
    dialled: async () => {
      const response = await fetch(`${httpOrigin}/__harness/arrivals`);
      const body = (await response.json()) as { arrivals: { role: 'daemon' | 'client'; daemonId: string }[] };
      return body.arrivals.filter(entry => entry.role === 'daemon').map(entry => entry.daemonId);
    },
    observations: async () => {
      const content = await readFile(observationsPath, 'utf8');
      if (content.trim() === '') return [];
      return content
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line) as ObservedFrame);
    },
    stop,
  };
}

/**
 * Wait until the compiled daemon has CLAIMED its rendezvous.
 *
 * There is no daemon-side observable for this — `BunRelayCarrier.status()` knows, and no route,
 * health field or boot-trail line says so; the trail's "dialling" line is printed BEFORE the claim
 * resolves and would be a false ready. So the honest signal is the rendezvous' own: it is holding a
 * socket in the `daemon` role for this fingerprint.
 */
/**
 * Wait for the daemon to say who it is, by dialling.
 *
 * The fingerprint has to be known before the rendezvous will admit it, and the daemon is the only
 * party that has one. Asking the rendezvous who knocked is race-free; reading the daemon's own boot
 * trail is not, because that line is written after its HTTP listener opens and a readiness poll can
 * therefore return first.
 */
export async function waitForDaemonFingerprint(
  rendezvous: RendezvousProcess,
  /**
   * Fingerprints already seen, which must not be mistaken for this daemon's.
   *
   * The journey probes the rendezvous with a SYNTHETIC fingerprint first, to prove an unlisted one
   * is refused — and that probe is a dial like any other. Taking the first entry returned a
   * fingerprint no daemon has, which then got allowlisted, and the real daemon was refused for
   * twenty seconds while the report blamed the daemon.
   */
  alreadySeen: readonly string[] = [],
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await rendezvous.dialled().catch(() => []);
    const fresh = seen.find(candidate => !alreadySeen.includes(candidate));
    if (fresh !== undefined) return fresh;
    await Bun.sleep(100);
  }
  throw new Error(`no daemon dialled the rendezvous within ${String(timeoutMs)}ms`);
}

/** Wait until at least `wanted` client sessions have arrived for this daemon; answer how many did. */
export async function waitForClientArrivals(
  rendezvous: RendezvousProcess,
  daemonId: string,
  wanted: number,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const arrivals = await rendezvous.arrivals().catch(() => []);
    seen = arrivals.filter(entry => entry.role === 'client' && entry.daemonId === daemonId).length;
    if (seen >= wanted) return seen;
    await Bun.sleep(150);
  }
  return seen;
}

export async function waitForDaemonAtRendezvous(rendezvous: RendezvousProcess, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = 'nothing';
  while (Date.now() < deadline) {
    const rows = await rendezvous.sockets().catch(() => []);
    seen = JSON.stringify(rows);
    if (rows.some(row => row.roles.includes('daemon'))) return;
    await Bun.sleep(100);
  }
  throw new Error(`the compiled daemon never claimed the rendezvous within ${String(timeoutMs)}ms (saw ${seen})`);
}

// ─── the direct address that must fail ────────────────────────────────────────────────────────

export interface DirectSinkhole {
  /** An origin the daemon can advertise and the browser will genuinely fail to use. */
  readonly origin: string;
  readonly port: number;
  /** How many times something opened a TCP connection to the advertised direct address. */
  attempts(): number;
  stop(): Promise<void>;
}

export async function startDirectSinkhole(teardown: HarnessTeardown): Promise<DirectSinkhole> {
  let attempts = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    attempts += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Destroy rather than answer. An HTTP status — any status — is an ANSWER under §13 and would
    // STOP the carrier walk instead of advancing it, which would prove the opposite of the point.
    socket.destroy();
  });
  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => settle());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the direct sinkhole took no IPv4 port');

  const stop = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((settle, fail) => server.close(error => (error === undefined ? settle() : fail(error))));
  };
  teardown.add('direct sinkhole', stop);
  return { origin: `http://127.0.0.1:${String(address.port)}`, port: address.port, attempts: () => attempts, stop };
}

// ─── the real bundle, on a real origin ────────────────────────────────────────────────────────

/**
 * Build the PWA once per suite run.
 *
 * The REAL bundle, not `renderToStaticMarkup` output: the existing `*.visual.test.tsx` tier renders
 * markup into a static page, which cannot pair with anything because the app is never running. What
 * makes this journey different is that the JavaScript that ships is the JavaScript that dials.
 *
 * Built with NO `FY_RELAY_DIRECTORY_ORIGIN`, deliberately — the fail-closed case. Discovery is
 * skipped entirely, there is no hosted fallback, and the rendezvous this journey crosses can only
 * have come from the pairing fragment and the daemon's published carrier set.
 */
let bundlePromise: Promise<string> | undefined;

/**
 * Built into the SUITE root, not a journey's own root.
 *
 * The memo is per process and the journeys are not: a bundle built into the first journey's
 * `paths.root` is deleted when that journey disposes, and the second journey then serves a
 * directory that is not there. Every request 404s, which reads as an app that cannot load — the
 * hour-long misdiagnosis this comment exists to prevent. `run-e2e.sh` removes the suite root once,
 * after every journey has finished.
 */
export async function buildPwaBundle(): Promise<string> {
  bundlePromise ??= (async () => {
    const suiteRoot = process.env.FY_E2E_RUN_ROOT ?? tmpdir();
    const outDir = await assertNoLiveStatePath(join(suiteRoot, 'fy-e2e-pwa-dist'), 'PWA bundle output');
    await mkdir(outDir, { recursive: true });
    const build = Bun.spawn(['bun', 'run', 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: join(REPOSITORY_ROOT, 'packages', 'pwa'),
      env: { ...process.env, FY_RELAY_DIRECTORY_ORIGIN: '', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`the PWA bundle failed to build (code ${String(code)})\n${out}\n${err}`);
    await stat(join(outDir, 'app', 'index.html'));
    return outDir;
  })();
  return bundlePromise;
}

export interface PwaOrigin {
  readonly origin: string;
  /** Every path the browser asked this origin for, so a 404 cannot pass as a working page. */
  requests(): readonly { readonly path: string; readonly status: number }[];
  /**
   * The 404s that are the APP's fault.
   *
   * `/favicon.ico` is excluded because the browser asks for it whether or not the page references
   * it, and this site declares `/icons/favicon.svg` in its document instead. Counting Chrome's own
   * unsolicited probe as a missing asset would fail every journey for a file the app never asked
   * for — and would train the next reader to ignore the check that catches a real one.
   */
  missingAssets(): readonly string[];
  stop(): Promise<void>;
}

/** Requests the browser makes on its own, which say nothing about whether the bundle is complete. */
const UNSOLICITED_PATHS: readonly string[] = [
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
];

/** `public/_redirects`, applied by this server because no Pages runtime is present to apply it. */
const SPA_ROUTES: readonly (readonly [RegExp, string])[] = [
  [/^\/app(\/.*)?$/u, 'app/index.html'],
  [/^\/d\/.*$/u, 'app/index.html'],
  [/^\/setup$/u, 'app/index.html'],
  [/^\/pair(\/.*)?$/u, 'app/index.html'],
];

async function contentSecurityPolicy(): Promise<string> {
  const headers = await readFile(HEADERS_FILE, 'utf8');
  const line = headers.split('\n').find(candidate => candidate.trim().startsWith('Content-Security-Policy:'));
  if (line === undefined) throw new Error('packages/pwa/public/_headers declares no Content-Security-Policy');
  return line.trim().slice('Content-Security-Policy:'.length).trim();
}

export async function startPwaOrigin(distDir: string, teardown: HarnessTeardown): Promise<PwaOrigin> {
  const policy = await contentSecurityPolicy();
  const requests: { path: string; status: number }[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      const route = SPA_ROUTES.find(([pattern]) => pattern.test(path));
      const candidates = route === undefined ? [path.replace(/^\//u, '') || 'index.html'] : [route[1]];
      for (const candidate of candidates) {
        const file = Bun.file(join(distDir, candidate));
        if (!(await file.exists())) continue;
        requests.push({ path, status: 200 });
        return new Response(file, {
          headers: {
            'Content-Security-Policy': policy,
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            // No caching anywhere: two journeys in one suite must not share a bundle state, and a
            // stale document is the kind of failure that reads as an app defect.
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }
      requests.push({ path, status: 404 });
      return new Response('not found', { status: 404 });
    },
  });

  const stop = async (): Promise<void> => {
    await server.stop(true);
  };
  teardown.add('PWA origin', stop);
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    requests: () => requests,
    missingAssets: () =>
      requests
        .filter(entry => entry.status === 404 && !UNSOLICITED_PATHS.includes(entry.path))
        .map(entry => entry.path),
    stop,
  };
}

// ─── the real browser ─────────────────────────────────────────────────────────────────────────

/**
 * The slice of `playwright-core` this journey uses.
 *
 * Declared here rather than imported as a type because `playwright-core` is a devDependency of
 * `packages/pwa` and `packages/daemon`, and is NOT resolvable from `tests/`: this repository
 * installs isolated, so the root `node_modules` holds `.bun` and per-package link trees, not a flat
 * copy. Resolving it at runtime from a package that DOES depend on it keeps this tier working
 * without changing a dependency this unit does not own. If the root ever declares it, nothing here
 * changes. The cost is honest and small: these shapes are hand-written, so an API drift shows up as
 * a runtime failure in this file rather than as a type error.
 */
export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  getAttribute(selector: string, name: string): Promise<string | null>;
  textContent(selector: string): Promise<string | null>;
  evaluate<T>(expression: string): Promise<T>;
  on(event: string, handler: (payload: unknown) => void): void;
  close(): Promise<void>;
}

export interface BrowserSession {
  readonly page: BrowserPage;
  /** Everything the page logged, so a silent failure in product code is visible to the report. */
  readonly console: readonly string[];
  readonly pageErrors: readonly string[];
  stop(): Promise<void>;
}

interface ChromiumLauncher {
  launch(options: { executablePath: string; headless: boolean; args: string[] }): Promise<{
    newContext(options?: Record<string, unknown>): Promise<{ newPage(): Promise<BrowserPage> }>;
    close(): Promise<void>;
  }>;
}

function resolvePlaywright(): string {
  const from = [REPOSITORY_ROOT, join(REPOSITORY_ROOT, 'packages', 'pwa'), join(REPOSITORY_ROOT, 'packages', 'daemon')];
  for (const directory of from) {
    try {
      return Bun.resolveSync('playwright-core', directory);
    } catch {
      // Try the next package that declares it.
    }
  }
  throw new Error('playwright-core is not installed; the real-browser E2E journey cannot run');
}

/** The Chrome this host actually has. No download, no bundled browser, no network. */
export function chromeExecutable(): string {
  const found = Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser');
  if (found === null) throw new Error('no google-chrome or chromium on PATH; the real-browser journey cannot run');
  return found;
}

export interface ChromeOptions {
  /**
   * A user agent carrying a marker unique to this run.
   *
   * The device NAMES ITSELF when it redeems, so the harness cannot pass a name in — but it can make
   * the name unique, because the app derives it from what the browser says about itself. That is
   * what turns "the device name must not reach the relay" from an assertion about a string nobody
   * chose into one the leak search can actually run.
   */
  readonly userAgent?: string;
}

export async function launchChrome(teardown: HarnessTeardown, options: ChromeOptions = {}): Promise<BrowserSession> {
  const module = (await import(resolvePlaywright())) as { chromium: ChromiumLauncher };
  const browser = await module.chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    // `--no-sandbox` because this host's Chrome refuses to start otherwise under the test runner,
    // and `--disable-dev-shm-usage` because a small `/dev/shm` in a container crashes the renderer
    // mid-journey, which looks exactly like an app defect.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1_280, height: 900 },
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  });
  const page = await context.newPage();

  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', payload => consoleLines.push(String((payload as { text(): string }).text())));
  page.on('pageerror', payload => pageErrors.push(String(payload)));

  const stop = async (): Promise<void> => {
    await browser.close();
  };
  teardown.add('chrome', stop);
  return { page, console: consoleLines, pageErrors, stop };
}

// ─── the step ledger ──────────────────────────────────────────────────────────────────────────

/**
 * What was proved, and the FIRST thing that was not.
 *
 * This journey spans four packages that are being written concurrently, so it will spend a while in
 * a state where some steps pass and one does not. The failure mode to avoid is a weaker test that
 * sounds end-to-end — so every step is named up front, recorded as it passes, and the report names
 * the first unproven step exactly rather than summarising. A run that ends early writes the same
 * report as a run that completes; only the contents differ.
 */
export interface LedgerStep {
  readonly id: string;
  readonly claim: string;
}

export interface StepLedger {
  prove(id: string, evidence: string): void;
  fail(id: string, because: string): never;
  write(path: string): Promise<void>;
  readonly firstUnproven: () => LedgerStep | undefined;
}

export function stepLedger(steps: readonly LedgerStep[]): StepLedger {
  const proved = new Map<string, string>();
  const failures = new Map<string, string>();
  const ledger: StepLedger = {
    prove: (id, evidence) => {
      if (steps.every(step => step.id !== id)) throw new Error(`unknown ledger step: ${id}`);
      proved.set(id, evidence);
    },
    fail: (id, because) => {
      failures.set(id, because);
      const step = steps.find(candidate => candidate.id === id);
      throw new Error(`UNPROVEN ${id} — ${step?.claim ?? 'unknown step'}\n  ${because}`);
    },
    /**
     * The step that FAILED, if one did; otherwise the first that was never reached.
     *
     * A failure aborts the journey, so anything after it is unreached through no fault of its own.
     * Reporting the earliest unreached step instead of the one that actually broke sends the reader
     * to the wrong package — which happened, and cost a round trip.
     */
    firstUnproven: () => steps.find(step => failures.has(step.id)) ?? steps.find(step => !proved.has(step.id)),
    write: async path => {
      const first = ledger.firstUnproven();
      const failed = first !== undefined && failures.has(first.id);
      const lines = [
        '# &F107 — compiled-binary real-browser relay proof',
        '',
        first === undefined
          ? 'EVERY STEP PROVED.'
          : `${failed ? 'FAILED STEP' : 'FIRST UNPROVEN STEP'}: ${first.id} — ${first.claim}\n  ${failures.get(first.id) ?? 'not reached'}`,
        '',
        '| step | state | evidence |',
        '| --- | --- | --- |',
        ...steps.map(step => {
          const evidence = proved.get(step.id);
          const state = evidence === undefined ? (failures.has(step.id) ? 'FAILED' : 'not reached') : 'proved';
          return `| \`${step.id}\` | ${state} | ${evidence ?? failures.get(step.id) ?? '—'} |`;
        }),
        '',
        ...steps.map(step => `- \`${step.id}\`: ${step.claim}`),
        '',
      ];
      await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
    },
  };
  return ledger;
}

/**
 * The device token, read out of the browser for ONE purpose and never for any other.
 *
 * A credential the harness holds is a credential the harness can spill, so this is the narrowest
 * shape that still lets the leak search run: the value is returned, handed straight to
 * {@link plaintextLeaks}, and never printed, written to the report, or compared to anything else.
 * {@link plaintextLeaks} reports the LABEL of a matched secret and never the secret, which is what
 * makes holding it briefly acceptable rather than merely convenient.
 */
export interface StoredDeviceToken {
  /** The credential, for {@link plaintextLeaks} and nothing else. Empty when none was found. */
  readonly token: string;
  /**
   * Where the reader looked and what it found there, as NAMES ONLY.
   *
   * A failure to find a credential has to be diagnosable without printing one, so this reports
   * database names, store names, record keys and JSON key paths — never a value. It is the whole
   * difference between "no device token is stored" (which is either a product defect or a reader
   * that is looking in the wrong place, and does not say which) and an answer.
   */
  readonly shape: string;
}

export async function deviceTokenForLeakSearchOnly(page: BrowserPage): Promise<StoredDeviceToken> {
  return page.evaluate<StoredDeviceToken>(`(async () => {
    const open = name => new Promise((settle, fail) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => settle(request.result);
      request.onerror = () => fail(request.error);
    });
    const all = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [{ name: 'ferretry-pwa' }];
    const notes = [];
    let token = '';
    for (const entry of all) {
      if (typeof entry.name !== 'string') continue;
      const database = await open(entry.name);
      for (const store of [...database.objectStoreNames]) {
        const records = await new Promise((settle, fail) => {
          const request = database.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => settle(request.result ?? []);
          request.onerror = () => fail(request.error);
        });
        const keys = new Set();
        const walk = (node, path) => {
          if (node === null || node === undefined) return;
          // The record is a SERIALISED document, not an object graph: the connections store holds
          // one JSON string. Walking it as an object found nothing and reported "no device token is
          // stored", which reads as a product defect and was a reader looking at the wrong shape.
          // (No backticks in this comment: it lives inside a template literal, and one would end it.)
          if (typeof node === 'string') {
            if (!node.trimStart().startsWith('{') && !node.trimStart().startsWith('[')) return;
            try {
              walk(JSON.parse(node), path);
            } catch {
              keys.add(path + '<unparseable string>');
            }
            return;
          }
          if (typeof node !== 'object') return;
          for (const [name, child] of Object.entries(node)) {
            keys.add(path + name);
            if (typeof child === 'string' && /token/i.test(name) && child !== '' && token === '') token = child;
            walk(child, path + name + '.');
          }
        };
        for (const record of records) walk(record, '');
        notes.push(entry.name + '/' + store + ' (' + records.length + ' record(s)): ' + [...keys].sort().join(', '));
      }
    }
    const local = Object.keys(localStorage).sort().join(', ');
    return { token, shape: notes.join(' | ') + ' || localStorage keys: ' + local };
  })()`);
}

/**
 * The assertion that makes the whole journey worth running.
 *
 * Every frame the rendezvous handled is searched for each secret, in the encodings a leak would
 * plausibly take: raw utf-8 and base64. A relay that can read a session is wrong however well it
 * works, and a harness that only checked the happy path would not notice.
 *
 * A hit reports the LABEL and the frame index. It never reports the value — a leak report that
 * printed the credential would be a second copy of the same defect.
 */
export function plaintextLeaks(
  frames: readonly ObservedFrame[],
  secrets: Readonly<Record<string, string>>,
): readonly string[] {
  const haystack = frames.map(frame => Buffer.from(frame.base64, 'base64'));
  const leaks: string[] = [];
  for (const [label, secret] of Object.entries(secrets)) {
    if (secret === '') continue;
    const needles = [Buffer.from(secret, 'utf8'), Buffer.from(Buffer.from(secret, 'utf8').toString('base64'), 'utf8')];
    for (const [index, frame] of haystack.entries()) {
      if (needles.some(needle => frame.includes(needle))) {
        leaks.push(`${label} appeared in relay-observable frame #${String(index)}`);
        break;
      }
    }
  }
  return leaks;
}

/**
 * Read an attribute that may not be there, WITHOUT waiting for it.
 *
 * `page.getAttribute` waits for the locator and throws after its timeout, so using it to report
 * what the page was showing after a failed wait costs a second full timeout and then loses the
 * answer to an exception. The diagnostic must be cheap and must never be the thing that fails.
 */
export async function attributeNow(page: BrowserPage, selector: string, name: string): Promise<string | null> {
  return page.evaluate<string | null>(
    `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`,
  );
}

/**
 * Click the first of several candidate selectors that is actually on the page.
 *
 * One hard-coded selector for "the primary button" is a guess about somebody else's markup, and
 * when the guess is wrong the failure reads as "the app ignored a click" rather than "the harness
 * clicked nothing". This tries the NAMED contracts first and structural fallbacks after, and
 * returns which one matched so the evidence line records what was actually pressed.
 */
export async function clickFirstPresent(page: BrowserPage, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const present = await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`);
    if (!present) continue;
    await page.click(selector, { timeout: 10_000 });
    return selector;
  }
  return null;
}

/** Every control the page is offering, so "no selector matched" can name what was there instead. */
export async function describeControls(page: BrowserPage, scope: string): Promise<string> {
  return page.evaluate<string>(
    `[...(document.querySelector(${JSON.stringify(scope)}) ?? document).querySelectorAll('button, [role="button"], a[href]')]
       .map(node => node.tagName.toLowerCase() + '[' + [...node.attributes].map(attribute => attribute.name + (attribute.value === '' ? '' : '=' + attribute.value.slice(0, 24))).join(' ') + ']: ' + (node.textContent ?? '').trim().slice(0, 40))
       .slice(0, 12)
       .join(' | ')`,
  );
}

/**
 * Every `data-*` the page actually rendered, WITH its value — what to say instead of "the selector
 * is missing".
 *
 * The values are the half that makes this actionable. `data-onboarding-screen` present tells you a
 * surface mounted; `data-onboarding-screen="entry"` tells you the app read the arrival as a cold
 * open, which is a completely different defect from a screen that failed to render. Values are
 * capped because a stray attribute carrying a serialised document would bury the answer.
 */
export async function renderedDataAttributes(page: BrowserPage): Promise<string> {
  return page.evaluate<string>(
    `[...new Set([...document.querySelectorAll('*')].flatMap(node =>
       [...node.attributes]
         .filter(attribute => attribute.name.startsWith('data-'))
         .map(attribute => attribute.value === '' ? attribute.name : attribute.name + '="' + attribute.value.slice(0, 40) + '"')
     ))].sort().join(', ')`,
  );
}
