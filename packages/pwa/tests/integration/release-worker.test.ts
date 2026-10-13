/**
 * The built service worker, in real Chromium: the end-to-end proof of `docs/pwa-release-signing.md`.
 *
 * WHY A BROWSER. The worker's claims are about what it SERVES — verified bytes from its own cache, a
 * refused update leaving the running version in place — and only a real worker, real Cache Storage
 * and real IndexedDB can show that. The decisions themselves are proved in `tests/unit/release-*.ts`.
 *
 * THE FIXTURE is a tiny site, not the app: a page, a script, the real `sw.verified.js` built from
 * `src/worker/service-worker.ts`, and a list signed with a throwaway key generated here (the build is
 * told to compile in that key's public half). Each scene then changes what the server serves and
 * asks the page what it sees. The build runs in a CHILD PROCESS, never in this one — see
 * `support/fy-render-integration-fixture.ts` for why a `Bun.build` inside the test runner wedges.
 *
 * The server listens on `127.0.0.1`, which the worker treats as a developer machine — so an
 * UNSIGNED build is answered "unverified" here rather than refused. Every other scene is signed, so
 * that allowance never decides their outcome; one scene asserts the allowance itself. "Older than
 * installed" is proved in `tests/unit/release-verification.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');

const PAGE = `<!doctype html><meta charset="utf-8"><title>release</title>
<script src="/assets/app.js"></script>`;
const SCRIPT = (label: string) => `window.releaseLabel = ${JSON.stringify(label)};`;

let workDirectory = '';
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
/** What the server serves right now: path → bytes. Each scene rewrites it. */
let served = new Map<string, Uint8Array>();
const requests: string[] = [];

const run = (command: string[], cwd = packageRoot): void => {
  const result = spawnSync(command[0] ?? '', command.slice(1), { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
};

const listFiles = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));

/** Builds and (optionally) signs one release of the fixture site; returns its files. */
const release = async (
  name: string,
  label: string,
  identity: { readonly commit: string; readonly createdAt: string },
  sign = true,
): Promise<Map<string, Uint8Array>> => {
  const dist = join(workDirectory, name);
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), PAGE);
  await writeFile(join(dist, 'assets/app.js'), SCRIPT(label));
  run([
    'bun',
    'run',
    'scripts/build-release.ts',
    dist,
    '--public-key',
    join(workDirectory, 'key.pub'),
    '--commit',
    identity.commit,
    '--created-at',
    identity.createdAt,
  ]);
  if (sign) {
    run([
      'bun',
      'run',
      'scripts/sign-release.ts',
      join(workDirectory, 'key.pem'),
      dist,
      '--public-key',
      join(workDirectory, 'key.pub'),
    ]);
  }
  const files = new Map<string, Uint8Array>();
  for (const path of await listFiles(dist)) files.set(path, new Uint8Array(await readFile(join(dist, path))));
  return files;
};

let first: Map<string, Uint8Array>;
let second: Map<string, Uint8Array>;
let unsigned: Map<string, Uint8Array>;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-release-worker-'));
  run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', join(workDirectory, 'key.pem')], workDirectory);
  run(
    ['openssl', 'pkey', '-in', join(workDirectory, 'key.pem'), '-pubout', '-out', join(workDirectory, 'key.pub')],
    workDirectory,
  );
  first = await release('first', 'first', { commit: 'aaaaaaa', createdAt: '2026-10-01T00:00:00Z' });
  second = await release('second', 'second', { commit: 'bbbbbbb', createdAt: '2026-10-02T00:00:00Z' });
  unsigned = await release('unsigned', 'unsigned', { commit: 'ccccccc', createdAt: '2026-10-03T00:00:00Z' }, false);

  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const { pathname } = new URL(request.url);
      requests.push(pathname);
      const path = pathname === '/' ? 'index.html' : pathname.slice(1);
      const bytes = served.get(path);
      if (bytes === undefined) return new Response('not found', { status: 404 });
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/plain';
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': type, 'cache-control': 'no-store' },
      });
    },
  });
}, 240_000);

afterAll(async () => {
  await server?.stop(true);
  if (workDirectory !== '') await rm(workDirectory, { recursive: true, force: true });
});

const origin = () => `http://127.0.0.1:${server.port}`;

/** A fresh browser profile with the worker installed and controlling the page. */
const installed = async (files: Map<string, Uint8Array>): Promise<{ context: BrowserContext; page: Page }> => {
  served = new Map(files);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin()}/`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.verified.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  // The first load was not controlled; this one is.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  return { context, page };
};

/** Asks the active worker one question, the way `use-release-integrity.ts` does. */
const ask = (page: Page, message: Record<string, unknown>) =>
  page.evaluate(
    async request =>
      await new Promise(resolveReply => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => resolveReply(event.data);
        navigator.serviceWorker.controller?.postMessage(request, [channel.port2]);
      }),
    message,
  );

const label = (page: Page) => page.evaluate(() => (window as unknown as { releaseLabel?: string }).releaseLabel);

describe('the signed-release service worker', () => {
  test('serves the verified release, even when the server goes away', async () => {
    const { context, page } = await installed(first);
    expect(await label(page)).toBe('first');

    served = new Map();
    await page.reload();

    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('installs a newer signed release and serves it on the next load', async () => {
    const { context, page } = await installed(first);
    served = new Map(second);

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({ type: 'fy-release-outcome', outcome: { status: 'updated' } });
    expect(await label(page)).toBe('second');
    await context.close();
  }, 120_000);

  test('refuses a release whose file was changed after signing, and keeps serving the old one', async () => {
    const { context, page } = await installed(first);
    served = new Map(second);
    served.set('assets/app.js', new TextEncoder().encode(SCRIPT('tampered')));

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({
      type: 'fy-release-outcome',
      outcome: { status: 'refused', refusal: 'hash-mismatch', hadRelease: true },
    });
    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('refuses a list whose signature does not match it', async () => {
    const { context, page } = await installed(first);
    served = new Map(second);
    served.set('release-manifest.sig', first.get('release-manifest.sig') ?? new Uint8Array());

    const reply = await ask(page, { type: 'fy-release-check' });

    expect(reply).toEqual({
      type: 'fy-release-outcome',
      outcome: { status: 'refused', refusal: 'bad-signature', hadRelease: true },
    });
    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('accepts an unsigned build only as "unverified", on a developer machine', async () => {
    const { context, page } = await installed(first);
    served = new Map(unsigned);

    const reply = await ask(page, { type: 'fy-release-check' });
    await page.reload();

    expect(reply).toEqual({ type: 'fy-release-outcome', outcome: { status: 'unverified' } });
    expect(await label(page)).toBe('first');
    await context.close();
  }, 120_000);

  test('tells the page whether a worker script is the signed one', async () => {
    const { context, page } = await installed(first);

    const signed = await ask(page, { type: 'fy-release-audit-worker', scriptUrl: `${origin()}/sw.verified.js` });
    served.set('sw.verified.js', new TextEncoder().encode('self.addEventListener("fetch", () => {});'));
    const replaced = await ask(page, { type: 'fy-release-audit-worker', scriptUrl: `${origin()}/sw.verified.js` });

    expect(signed).toEqual({ type: 'fy-release-worker-audit', signed: true });
    expect(replaced).toEqual({ type: 'fy-release-worker-audit', signed: false });
    await context.close();
  }, 120_000);

  test('leaves a file no release lists to the network, untouched', async () => {
    const { context, page } = await installed(first);
    requests.length = 0;

    const status = await page.evaluate(async () => (await fetch('/not-listed.txt')).status);

    expect(status).toBe(404);
    expect(requests).toContain('/not-listed.txt');
    await context.close();
  }, 120_000);
});
