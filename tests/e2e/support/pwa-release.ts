/**
 * The PWA as it is RELEASED, for journeys about what a browser does with a release: the real
 * `vite build`, the real release step (`scripts/build-release.ts`), the real CI signer
 * (`scripts/ci/sign-pwa-release.sh`), an origin that can switch which release it serves, and a
 * Chrome whose window size, colour scheme and host mapping a journey chooses.
 *
 * WHY NOT `relay-harness.ts`'s `buildPwaBundle`: that one builds once per process against one relay
 * directory, signs nothing, and serves a fixed directory. A release journey needs several releases of
 * the same build — signed, tampered, unsigned, older — served one after another to ONE origin, because
 * a service worker's memory of what it installed is per origin.
 *
 * THE TRUST ROOT IS A THROWAWAY KEY generated per run with `openssl`, passed to the release step as
 * `--public-key`, exactly as `packages/pwa/tests/integration/release-worker.test.ts` does. The real
 * release key is never read: the build compiles in whichever public key it is handed, and the private
 * half of this one is deleted with the run root.
 */
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertNoLiveStatePath } from '../fixture.ts';
import { chromeExecutable, type HarnessTeardown } from './relay-harness.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const PWA_ROOT = join(REPOSITORY_ROOT, 'packages', 'pwa');
const HEADERS_FILE = join(PWA_ROOT, 'public', '_headers');
/** Every release step stamps this, so two runs of one build are byte-comparable. */
const CREATED_AT = '2026-10-01T00:00:00Z';

function run(command: readonly string[], cwd: string, env: Record<string, string> = {}, input?: Uint8Array): string {
  const result = spawnSync(command[0] ?? '', command.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command.join(' ')} failed (${String(result.status)}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

export interface ReleaseKey {
  readonly privatePem: string;
  readonly publicPem: string;
}

/** A throwaway Ed25519 key pair under `directory`. */
export async function throwawayKey(directory: string, name: string): Promise<ReleaseKey> {
  await mkdir(directory, { recursive: true });
  const privatePem = await assertNoLiveStatePath(join(directory, `${name}.pem`), 'release key');
  const publicPem = join(directory, `${name}.pub`);
  run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', privatePem], directory);
  run(['openssl', 'pkey', '-in', privatePem, '-pubout', '-out', publicPem], directory);
  return { privatePem, publicPem };
}

const builds = new Map<string, Promise<string>>();

/**
 * One `vite build` of this checkout, memoised per output directory and relay directory origin.
 *
 * The three steps are the package's `build` script spelled out, because `bun run build --outDir X`
 * appends the flag to the LAST command of that script — the release step since #462 — so vite wrote
 * `packages/pwa/dist` and X stayed empty. Spelling them out also lets the release step run separately
 * per release, below, without paying for a second vite build.
 */
export async function viteBuild(outDir: string, relayDirectoryOrigin: string): Promise<string> {
  const key = `${outDir}\n${relayDirectoryOrigin}`;
  let built = builds.get(key);
  if (built === undefined) {
    built = (async () => {
      const safe = await assertNoLiveStatePath(outDir, 'PWA build output');
      await mkdir(safe, { recursive: true });
      run(['bun', 'run', 'build:fy-render-shell'], PWA_ROOT);
      run(['bun', 'x', 'vite', 'build', '--outDir', safe, '--emptyOutDir'], PWA_ROOT, {
        FY_RELAY_DIRECTORY_ORIGIN: relayDirectoryOrigin,
      });
      await readFile(join(safe, 'app', 'index.html'));
      return safe;
    })();
    builds.set(key, built);
  }
  return built;
}

export interface ReleaseOptions {
  /** The vite output to release; it is copied, never modified. */
  readonly build: string;
  readonly into: string;
  readonly key: ReleaseKey;
  readonly sequence: number;
  readonly commit: string;
  /** `false` leaves the release step's own `unsigned` signature file in place. */
  readonly sign: boolean;
}

/** A copy of `build` with its release manifest written and, when asked, signed by `key`. */
export async function release(options: ReleaseOptions): Promise<string> {
  const into = await assertNoLiveStatePath(options.into, 'PWA release');
  await rm(into, { recursive: true, force: true });
  await cp(options.build, into, { recursive: true });
  run(
    [
      'bun',
      'run',
      'scripts/build-release.ts',
      into,
      '--public-key',
      options.key.publicPem,
      '--commit',
      options.commit,
      '--sequence',
      String(options.sequence),
      '--created-at',
      CREATED_AT,
    ],
    PWA_ROOT,
  );
  if (options.sign) {
    run(
      [
        join(REPOSITORY_ROOT, 'scripts', 'ci', 'sign-pwa-release.sh'),
        '--sequence',
        String(options.sequence),
        '--commit',
        options.commit,
        '--public-key',
        options.key.publicPem,
        into,
      ],
      REPOSITORY_ROOT,
      {},
      new Uint8Array(await readFile(options.key.privatePem)),
    );
  }
  return into;
}

/** `public/_redirects`, applied here because no Pages runtime is present to apply it. */
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

export interface ReleaseOrigin {
  /** `http://127.0.0.1:<port>` — what the server binds. */
  readonly loopbackOrigin: string;
  readonly port: number;
  /** Switches every later response to `directory`; `undefined` makes the origin answer nothing. */
  serve(directory: string | undefined): void;
  requests(): readonly string[];
  stop(): Promise<void>;
}

/**
 * One loopback origin whose release can be swapped between requests, under the site's real CSP.
 *
 * `serve(undefined)` is a server that is still listening and refuses everything with 503, which is
 * what "the network is gone" looks like to a worker that bypasses the HTTP cache.
 */
export async function startReleaseOrigin(teardown: HarnessTeardown): Promise<ReleaseOrigin> {
  const policy = await contentSecurityPolicy();
  const requests: string[] = [];
  let root: string | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (root === undefined) return new Response('offline', { status: 503 });
      const route = SPA_ROUTES.find(([pattern]) => pattern.test(path));
      const candidate = route === undefined ? path.replace(/^\//u, '') || 'index.html' : route[1];
      const file = Bun.file(join(root, candidate));
      if (!(await file.exists())) return new Response('not found', { status: 404 });
      return new Response(file, {
        headers: {
          'Content-Security-Policy': policy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    },
  });
  const stop = async (): Promise<void> => {
    await server.stop(true);
  };
  teardown.add('release origin', stop);
  const port = server.port ?? 0;
  return {
    loopbackOrigin: `http://127.0.0.1:${String(port)}`,
    port,
    serve: directory => {
      root = directory;
    },
    requests: () => [...requests],
    stop,
  };
}

/** The slice of a Playwright page these journeys use. */
export interface ReleasePage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  evaluate<T>(expression: string): Promise<T>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  emulateMedia(options: { colorScheme: 'light' | 'dark' }): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
}

export interface ReleaseBrowser {
  readonly page: ReleasePage;
  readonly console: readonly string[];
  setOffline(offline: boolean): Promise<void>;
  stop(): Promise<void>;
}

interface PlaywrightContext {
  newPage(): Promise<ReleasePage>;
  setOffline(offline: boolean): Promise<void>;
  grantPermissions(permissions: readonly string[]): Promise<void>;
}

interface PlaywrightChromium {
  launch(options: { executablePath: string; headless: boolean; args: string[] }): Promise<{
    newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>;
    close(): Promise<void>;
  }>;
}

function resolvePlaywright(): string {
  for (const directory of [REPOSITORY_ROOT, PWA_ROOT, join(REPOSITORY_ROOT, 'packages', 'daemon')]) {
    try {
      return Bun.resolveSync('playwright-core', directory);
    } catch {
      // Try the next package that declares it.
    }
  }
  throw new Error('playwright-core is not installed; the real-browser journey cannot run');
}

export interface ReleaseBrowserOptions {
  /**
   * A hostname Chrome resolves to 127.0.0.1 and treats as a secure context, so the page is NOT on a
   * loopback name. The release worker deliberately relaxes on `localhost`/`127.x` (an unsigned build
   * is "unverified" there, never refused), so a journey about refusals must be on a name a real site
   * could have. Nothing is resolved by DNS and nothing leaves the machine: the mapping is Chrome's.
   */
  readonly host?: { readonly name: string; readonly port: number };
}

export async function launchReleaseBrowser(
  teardown: HarnessTeardown,
  options: ReleaseBrowserOptions = {},
): Promise<ReleaseBrowser> {
  const module = (await import(resolvePlaywright())) as { chromium: PlaywrightChromium };
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (options.host !== undefined) {
    args.push(
      `--host-resolver-rules=MAP ${options.host.name} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=http://${options.host.name}:${String(options.host.port)}`,
    );
  }
  const browser = await module.chromium.launch({ executablePath: chromeExecutable(), headless: true, args });
  const context = await browser.newContext({ viewport: { width: 1_280, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['local-network-access']).catch(() => undefined);
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on('console', payload => consoleLines.push(String((payload as { text(): string }).text())));
  page.on('pageerror', payload => consoleLines.push(`pageerror: ${String(payload)}`));
  const stop = async (): Promise<void> => {
    await browser.close();
  };
  teardown.add('release chrome', stop);
  return { page, console: consoleLines, setOffline: offline => context.setOffline(offline), stop };
}

/** The theme the document is actually painted in, from `<html data-theme="<family>-<mode>">`. */
async function paintedScheme(page: ReleasePage): Promise<string> {
  return await page.evaluate<string>("(document.documentElement.getAttribute('data-theme') ?? '').split('-').pop()");
}

export interface ScreenshotSet {
  readonly paths: readonly string[];
  /**
   * Whether the page repainted when the OS colour scheme changed under it. When it did not, the
   * shot was taken after a reload instead, and the journey can report that the screen does not
   * follow the scheme live.
   */
  readonly followedLive: boolean;
}

/**
 * The four shots every user-visible state gets: 390px and 1280px, light and dark.
 *
 * `waitFor` is the selector that defines the state, re-awaited after any reload this needs.
 */
export async function screenshotMatrix(
  page: ReleasePage,
  directory: string,
  name: string,
  waitFor?: string,
): Promise<ScreenshotSet> {
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  let followedLive = true;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await Bun.sleep(300);
    if ((await paintedScheme(page)) !== scheme) {
      followedLive = false;
      await page.reload({ waitUntil: 'load' });
      if (waitFor !== undefined) await page.waitForSelector(waitFor, { timeout: 30_000 });
      await Bun.sleep(300);
    }
    paths.push(...(await screenshotWidths(page, directory, name, scheme)));
  }
  await page.setViewportSize({ width: 1_280, height: 900 });
  // One line per state, beside the shots, so a reviewer can see which screens repainted live.
  await appendFile(join(directory, 'theme-follow.jsonl'), `${JSON.stringify({ name, followedLive })}\n`, 'utf8');
  await page.emulateMedia({ colorScheme: 'light' });
  return { paths, followedLive };
}

/**
 * Polls `expression` in the page until it is truthy.
 *
 * Not Playwright's `waitForFunction`: that compiles its predicate inside the page, which the site's
 * own CSP (no `unsafe-eval`) refuses — correctly. `evaluate` runs through the debugger protocol.
 */
export async function waitInPage(page: ReleasePage, expression: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    } catch (error) {
      // A navigation in flight destroys the context the expression ran in; ask again.
      last = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${expression}`, { cause: last });
}

/**
 * The 390px and 1280px shots of whatever is on screen now, named for `scheme`.
 *
 * For a state that cannot be reached again by reloading — a failed pairing is one — the caller sets
 * the colour scheme BEFORE driving to the state and calls this once per scheme.
 */
export async function screenshotWidths(
  page: ReleasePage,
  directory: string,
  name: string,
  scheme: 'light' | 'dark',
): Promise<readonly string[]> {
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (const [label, width, height] of [
    ['390', 390, 844],
    ['1280', 1_280, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await Bun.sleep(200);
    const path = join(directory, `${name}-${label}-${scheme}.png`);
    await page.screenshot({ path });
    paths.push(path);
  }
  await page.setViewportSize({ width: 1_280, height: 900 });
  return paths;
}
