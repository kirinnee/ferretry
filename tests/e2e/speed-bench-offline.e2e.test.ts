import { join } from 'node:path';
import { describe, it } from 'bun:test';
import should from 'should';
import { withE2eEnvironment } from './fixture';
import { startPagesDev } from './support/pages-dev';
import { viteBuild } from './support/pwa-release';
import { retryOnLostBrowser } from './support/product-harness';
import {
  chromeExecutable,
  closeChromeBounded,
  harnessTeardown,
  launchChromiumWithRetry,
  resolvePlaywright,
} from './support/relay-harness';

/**
 * The speed test page (`/speed-bench/`), from the PRODUCTION bundle, under PRODUCTION Pages semantics (the
 * real `_headers` policy, served by `wrangler pages dev`): with its defaults it asks for NOTHING beyond the
 * site's own files, and the one way to reach `huggingface.co` is the person ticking the box that names it.
 *
 * WHY IT IS A BUILT-PAGE JOURNEY. A review reproduced four external GETs from a fresh device: the box was
 * ticked by default, so Run installed the pinned models. The page's HTML cannot show that — the requests are
 * made by scripts the page loads, and by the speech workers those scripts start — so every request the
 * browser makes is recorded (document, module chunks, wasm, workers and anything they ask for), and every
 * request to another origin is answered here, never by the real network.
 */

/** Never a real service: the bundle's relay discovery points at a closed loopback port. */
const DEAD_DIRECTORY = 'http://127.0.0.1:9';

/** The slice of `playwright-core` this journey uses; see `fy-render-pages.e2e.test.ts` for why it is hand-written. */
interface JourneyRoute {
  request(): { url(): string; headers(): Record<string, string> };
  fulfill(response: { status: number; contentType: string; body: string }): Promise<void>;
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface JourneyPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
}
interface JourneyContext {
  newPage(): Promise<JourneyPage>;
  route(url: (url: URL) => boolean, handler: (route: JourneyRoute) => Promise<void>): Promise<void>;
}
interface JourneyBrowser {
  newContext(options?: Record<string, unknown>): Promise<JourneyContext>;
  close(): Promise<void>;
}
interface Playwright {
  readonly chromium: { launch(options: Record<string, unknown>): Promise<JourneyBrowser> };
}

interface Seen {
  readonly url: string;
  readonly referer: string | undefined;
}

/** A fresh browser on the built site; every request is recorded, other origins are answered by `outside`. */
async function openBuiltSpeedPage(
  origin: string,
  teardown: ReturnType<typeof harnessTeardown>,
  outside: (route: JourneyRoute) => Promise<void>,
): Promise<{ page: JourneyPage; seen: Seen[] }> {
  const playwright = (await import(resolvePlaywright())) as Playwright;
  const browser = await launchChromiumWithRetry(() =>
    playwright.chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      executablePath: chromeExecutable(),
      headless: true,
      timeout: 20_000,
    }),
  );
  teardown.add('speed-bench chrome', async () => await closeChromeBounded(browser));
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const seen: Seen[] = [];
  await context.route(
    () => true,
    async route => {
      const request = route.request();
      seen.push({ referer: request.headers().referer, url: request.url() });
      if (new URL(request.url()).origin === origin) await route.continue();
      else await outside(route);
    },
  );
  const page = await context.newPage();
  await page.goto(`${origin}/speed-bench/`, { timeout: 60_000, waitUntil: 'load' });
  return { page, seen };
}

/**
 * Waits for a finished run by polling the summary line. Not `waitForFunction`: that compiles its expression
 * with `new Function`, which the page's real policy (no `unsafe-eval`) refuses — the policy under test stays on.
 */
async function waitForSummary(page: JourneyPage, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (((await page.evaluate<string>(`document.getElementById('summary').textContent`)) ?? '') !== '') return;
    await Bun.sleep(250);
  }
  throw new Error('the speed test never finished a run');
}

describe('the speed test page on Cloudflare Pages', () => {
  it('should ask for nothing beyond the site’s own files with its defaults, and say what to do about voices that are not installed', () =>
    retryOnLostBrowser('speed-bench-defaults', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange — the production build on a fresh device (no model installed), served as Pages serves it.
          const root = environment.paths.root;
          const dist = await viteBuild(join(root, 'vite'), DEAD_DIRECTORY);
          const { origin } = await startPagesDev(dist, join(root, 'wrangler'), teardown);
          const { page, seen } = await openBuiltSpeedPage(origin, teardown, route => route.abort());

          // Act — press Run without touching anything.
          const ticked = await page.evaluate<boolean>(`document.getElementById('install').checked`);
          await page.click('#run');
          await waitForSummary(page, 120_000);

          // Assert — the box was unticked, and EVERY request (document, scripts, chunks, wasm, workers) was the site's own.
          should(ticked).be.false();
          const outbound = seen.filter(request => new URL(request.url).origin !== origin).map(request => request.url);
          should(outbound).deepEqual([]);
          // The check saw the page's scripts, not just its HTML.
          should(seen.some(request => /\/assets\/[^/]+\.js$/u.test(request.url))).be.true();
          should(seen.some(request => /\/assets\/clip-5s-[^/]+\.wav$/u.test(request.url))).be.true();
          // The rows say "not installed" and the page says what to do.
          const summary = await page.evaluate<string>(`document.getElementById('summary').textContent`);
          should(summary).containEql('Install the voice in Settings › Voice first, then run again.');
          const report = JSON.parse(await page.evaluate<string>(`document.getElementById('result').textContent`)) as {
            runs: { failure: string | null }[];
          };
          should(report.runs.length).be.above(0);
          should(report.runs.every(run => run.failure === 'not-installed')).be.true();
        });
      } finally {
        await teardown.closeAll();
      }
    }));

  it('should reach huggingface.co only when the person ticks the download box, and send it no address of the page', () =>
    retryOnLostBrowser('speed-bench-ticked', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange — the same build; no real network: the model host answers "not found", anything else is refused.
          const root = environment.paths.root;
          const dist = await viteBuild(join(root, 'vite'), DEAD_DIRECTORY);
          const { origin } = await startPagesDev(dist, join(root, 'wrangler'), teardown);
          const { page, seen } = await openBuiltSpeedPage(origin, teardown, async route => {
            if (new URL(route.request().url()).hostname === 'huggingface.co')
              await route.fulfill({ body: 'not found', contentType: 'text/plain', status: 404 });
            else await route.abort();
          });
          const beforeTick = seen.length;
          should(seen.filter(request => new URL(request.url).origin !== origin)).deepEqual([]);

          // Act — tick the box that names the download, then Run.
          await page.click('#install');
          const label = await page.evaluate<string>(`document.getElementById('install-label').textContent`);
          await page.click('#run');
          await waitForSummary(page, 120_000);

          // Assert — the label names the host and the size; the only other origin reached is that host, with no referrer.
          should(label).match(/^Download the speech models first \(from huggingface\.co, about \d+ MB\)$/u);
          const outbound = seen.slice(beforeTick).filter(request => new URL(request.url).origin !== origin);
          should(outbound.length).be.above(0);
          should([...new Set(outbound.map(request => new URL(request.url).hostname))]).deepEqual(['huggingface.co']);
          should(outbound.every(request => request.referer === undefined)).be.true();
        });
      } finally {
        await teardown.closeAll();
      }
    }));
});
