/**
 * THE BUILT APP'S ENTRY UNDER THE REAL POLICY: 0 Trusted Types violations (r12 H8 fix, review item 2).
 *
 * zod 4 probes `new Function('')` the first time a schema is made, and the app's policy (`require-trusted-types-for 'script'`,
 * `public/_headers`) REPORTS that probe as a violation. `zod-jitless.ts` turns the probe off, and it must run before any schema
 * is built. An import that is first in `main.tsx` is not enough in a bundle: the bundler puts shared static chunks (which build
 * schemas when they evaluate) ahead of the entry's own body, so the setting ran after them (one violation, measured on the
 * real build). The unit test of the module cannot see that, and neither can a scene built with a different bundler.
 *
 * So this builds the REAL app (the shell's own `vite.config.ts`, every plugin it registers), serves the build with the exact
 * `Content-Security-Policy` of `public/_headers`, loads `/app/` in real Chromium, and counts `securitypolicyviolation` events
 * and `new Function('')` calls made before zod's JIT was off. Both must be none. The same build is held to ship Durian's
 * stylesheet (the app's own stylesheet has no `.dh-doc` rule of Durian's unless the bare CSS import survived the Conversation
 * package's `"sideEffects": false`, which the Durian plugin sees to).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import type { Rollup } from 'vite';
import { build } from 'vite';
import { sharedChromium } from '../support/browser/index.ts';

const packageRoot = resolve(import.meta.dir, '../..');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve> | undefined;
let origin = '';
const built = new Map<string, string | Blob>();

beforeAll(async () => {
  browser = await sharedChromium();
  const headers = await readFile(join(packageRoot, 'public/_headers'), 'utf8');
  const policy =
    headers
      .split('\n')
      .find(line => line.trim().startsWith('Content-Security-Policy:'))
      ?.trim()
      .slice('Content-Security-Policy:'.length)
      .trim() ?? '';
  if (!policy.includes("require-trusted-types-for 'script'")) throw new Error('the real policy lost Trusted Types');

  // `NODE_ENV=test` would make Vite build React's development bundle; a production page is what is asked about.
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = (await build({
      root: packageRoot,
      configFile: join(packageRoot, 'vite.config.ts'),
      logLevel: 'silent',
      mode: 'production',
      build: { write: false },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    for (const output of (Array.isArray(result) ? result : [result]).flatMap(r => r.output)) {
      if (output.type === 'chunk') built.set(output.fileName, output.code);
      else
        built.set(
          output.fileName,
          typeof output.source === 'string' ? output.source : new Blob([output.source as BlobPart]),
        );
    }
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      const name = path === '/app/' ? 'app/index.html' : path.replace(/^\//u, '');
      const type = CONTENT_TYPES[extname(name)] ?? 'application/octet-stream';
      const secured = (body: string | Blob): Response =>
        new Response(body, { headers: { 'content-security-policy': policy, 'content-type': type } });
      const inMemory = built.get(name);
      if (inMemory !== undefined) return secured(inMemory);
      if (name.split('/').includes('..')) return new Response('', { status: 400 });
      const file = Bun.file(join(packageRoot, 'public', name));
      return (await file.exists()) ? secured(file) : new Response('', { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 280_000);

afterAll(async () => {
  await server?.stop(true);
});

describe('the built app', () => {
  it('loads its first screen with 0 Trusted Types violations and no schema built before zod’s JIT is off', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    // Nothing but the build's own origin: a request anywhere else is aborted, so it can neither help nor hurt.
    await context.route('**/*', route =>
      route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
    );
    await context.addInitScript(() => {
      const found = { csp: [] as string[], probesBeforeJitless: 0 };
      Object.assign(window, { fyFound: found });
      document.addEventListener('securitypolicyviolation', event =>
        found.csp.push(`${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`),
      );
      // zod's probe is `new Function('')`; count the ones made while its JIT is still on.
      const jitless = (): boolean =>
        (globalThis as { __zod_globalConfig?: { jitless?: boolean } }).__zod_globalConfig?.jitless === true;
      globalThis.Function = new Proxy(globalThis.Function, {
        construct(target, args, newTarget) {
          if (args.length === 1 && args[0] === '' && !jitless()) found.probesBeforeJitless += 1;
          return Reflect.construct(target, args, newTarget) as object;
        },
      });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/app/`, { waitUntil: 'load' });
    // The first screen drew: the app's root has content, whichever screen the empty device lands on.
    await page.waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 0) > 0, undefined, {
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);
    const found = await page.evaluate(
      () => (window as unknown as { fyFound: { csp: string[]; probesBeforeJitless: number } }).fyFound,
    );
    await context.close();
    expect(errors).toEqual([]);
    expect(found.csp).toEqual([]);
    expect(found.probesBeforeJitless).toBe(0);
  }, 90_000);

  it('ships Durian’s stylesheet: its rules are in the app’s CSS, not only ours', () => {
    const sheets = [...built.entries()]
      .filter(([name]) => name.endsWith('.css'))
      .map(([, text]) => (typeof text === 'string' ? text : ''));
    // Durian's own rules: the part chrome, and the animation stage's mode button (the app's own CSS has neither).
    expect(sheets.some(sheet => sheet.includes('.dh-doc') && sheet.includes('.scn-mode'))).toBe(true);
  });
});
