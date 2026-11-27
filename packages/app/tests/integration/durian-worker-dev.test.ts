/** The real Vite dev configuration must start the real worker under enforcing Trusted Types, and trust only its URL. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { sharedChromium } from '../support/browser/index.ts';

const app = resolve(import.meta.dir, '../..');
const conversation = resolve(app, '../plugins/conversation/app/hypermedia');
let server: ViteDevServer | undefined;
let cache = '';
let origin = '';

beforeAll(async () => {
  cache = await mkdtemp(join(tmpdir(), 'fy-durian-dev-'));
  const headers = await readFile(join(app, 'public/_headers'), 'utf8');
  const policy = headers
    .split('\n')
    .find(line => line.trim().startsWith('Content-Security-Policy:'))
    ?.trim()
    .slice('Content-Security-Policy:'.length)
    .trim();
  if (!policy?.includes("require-trusted-types-for 'script'")) throw new Error('Trusted Types must be enforced');
  server = await createServer({
    root: app,
    configFile: join(app, 'vite.config.ts'),
    cacheDir: cache,
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 7489,
      strictPort: true,
      hmr: false,
      headers: { 'Content-Security-Policy': policy },
    },
    plugins: [
      {
        name: 'durian-dev-fixture',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== '/__durian-test') return next();
            response.setHeader('Content-Type', 'text/html');
            response.setHeader('Content-Security-Policy', policy);
            response.end('<!doctype html><script type="module" src="/__durian-test.ts"></script>');
          });
        },
        resolveId: id => (id === '/__durian-test.ts' ? '\0durian-dev-fixture' : null),
        load: id =>
          id !== '\0durian-dev-fixture'
            ? null
            : `
        import ${JSON.stringify(join(app, 'src/security/zod-jitless.ts'))};
        import { spawnDurianWorker } from ${JSON.stringify(join(conversation, 'durian-spawn.ts'))};
        import workerUrl from ${JSON.stringify(join(conversation, 'durian-worker-url.ts'))};
        import { isWorkerScriptUrl, trustedWorkerUrl } from ${JSON.stringify(join(app, 'src/security/trusted-types.ts'))};
        const state = window.durianTest = { workerUrl, ready: false, error: '', secondPathAllowed: false, trusted: false };
        const secondPath = workerUrl.replace('/packages/plugins/', '/other-checkout/packages/plugins/');
        state.secondPathAllowed = isWorkerScriptUrl(secondPath);
        state.trusted = trustedTypes.isScriptURL(trustedWorkerUrl(workerUrl));
        try {
          const worker = await spawnDurianWorker();
          worker.onmessage = event => {
            if (event.data?.kind === 'ready') { state.ready = true; worker.terminate(); }
          };
          worker.onerror = event => { state.error = event.message; worker.terminate(); };
        } catch (error) { state.error = String(error); }
      `,
      },
    ],
  });
  await server.listen();
  origin = 'http://127.0.0.1:7489';
}, 120_000);

afterAll(async () => {
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

for (const assertion of ['ready', 'second checkout'] as const) {
  test(`the Vite dev worker: ${assertion}`, async () => {
    const browser = await sharedChromium();
    const context = await browser.newContext();
    try {
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        Object.assign(window, { violations: [] as string[] });
        document.addEventListener('securitypolicyviolation', event => {
          (window as unknown as { violations: string[] }).violations.push(event.effectiveDirective);
        });
      });
      const response = await page.goto(`${origin}/__durian-test`);
      expect(response?.headers()['content-security-policy']).toContain("require-trusted-types-for 'script'");
      // Poll through CDP: waitForFunction itself uses a script sink forbidden by the policy under test.
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (await page.evaluate('!!window.durianTest && (window.durianTest.ready || window.durianTest.error)')) break;
        await page.waitForTimeout(100);
      }
      const state = await page.evaluate(
        () =>
          (
            window as unknown as {
              durianTest: {
                ready: boolean;
                error: string;
                secondPathAllowed: boolean;
                trusted: boolean;
                workerUrl: string;
              };
            }
          ).durianTest,
      );
      expect(state?.workerUrl).toContain(
        '/packages/plugins/conversation/app/hypermedia/durian-worker.ts?worker_file&type=module',
      );
      expect(state?.trusted).toBe(true);
      if (assertion === 'ready') {
        expect(state?.error).toBe('');
        expect(state?.ready).toBe(true);
      } else expect(state?.secondPathAllowed).toBe(false);
      expect(errors).toEqual([]);
      expect(await page.evaluate('window.violations')).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);
}
