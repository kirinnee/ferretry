import { readdir, readFile } from 'node:fs/promises';
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
 * The `fy-render` sandbox shells, from the PRODUCTION bundle, under PRODUCTION Pages semantics.
 *
 * WHY THIS JOURNEY EXISTS. Every Mermaid and every interactive html block in production read "The
 * illustration sandbox did not start". The shells were in `dist`, the component was right and every
 * other tier was green — because no tier served the build the way Cloudflare Pages does. Pages'
 * pretty URLs answer `/fy-render-sandbox.html` with a 308 to `/fy-render-sandbox`, `_headers`
 * matches the requested path, and the only rule for that path was `/*`, carrying
 * `frame-ancestors 'none'`. The browser refused the frame and the shell never announced itself.
 *
 * So this journey changes nothing about the production path: the real `vite build`, served by
 * `wrangler pages dev` (real `_headers`, real `_redirects`, real 308s), opened as the app page in a
 * real Chrome. The shell URLs are READ OUT OF THE BUILT BUNDLE rather than restated, so a component
 * that starts pointing somewhere else is followed here too. Service workers are blocked, so the
 * frames take the network path a first visit takes; the worker serves the same `_headers` rules for
 * the requested path itself. The same page proves the production policy lets the `html` fragment
 * sanitizer create its one `fy-fragment` Trusted Types policy — and no other.
 */

/** Never a real service: the bundle's relay discovery points at a closed loopback port. */
const DEAD_DIRECTORY = 'http://127.0.0.1:9';

/** Every quoted `/fy-render-*.html` path the shipped scripts name. */
async function shellPathsInBundle(dist: string): Promise<readonly string[]> {
  const found = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js'))
        for (const match of (await readFile(path, 'utf8')).matchAll(/["'`](\/fy-render-[a-z]+\.html)["'`]/gu))
          found.add(match[1] as string);
    }
  };
  await walk(join(dist, 'assets'));
  return [...found].toSorted();
}

/**
 * Mounts a shell exactly as the component does — `sandbox="allow-scripts"`, the listener before
 * `src`, an identity-checked handshake, then one command over the port — and returns every reply.
 */
const drive = (shellPath: string, command: Record<string, unknown>, library: string | null): string => `(async () => {
  const library = ${library === null ? 'null' : `await fetch(${JSON.stringify(library)}, { credentials: 'omit', cache: 'no-cache' }).then(r => r.text())`};
  return await new Promise(resolve => {
    const replies = [];
    let ready = false;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:600px;height:400px;border:0';
    const finish = () => resolve({ ready, replies });
    addEventListener('message', function onGlobal(event) {
      if (event.source !== frame.contentWindow || !event.data || event.data.kind !== 'shell-ready') return;
      removeEventListener('message', onGlobal);
      ready = true;
      const channel = new MessageChannel();
      channel.port1.onmessage = e => {
        replies.push(e.data);
        if (e.data && (e.data.kind === 'mermaid-svg' || e.data.kind === 'rendered' || e.data.kind === 'error')) setTimeout(finish, 200);
      };
      frame.contentWindow.postMessage({ kind: 'init' }, '*', [channel.port2]);
      channel.port1.postMessage(Object.assign({}, ${JSON.stringify(command)}, library === null ? {} : { library }));
    });
    document.body.appendChild(frame);
    frame.src = ${JSON.stringify(shellPath)};
    setTimeout(finish, 30000);
  });
})()`;

/**
 * The slice of `playwright-core` this journey uses, hand-written because the package is not
 * resolvable from `tests/` for the typechecker — the same stance `relay-harness.ts` takes.
 */
interface JourneyPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  on(event: 'console', handler: (message: { text(): string }) => void): void;
}
interface JourneyBrowser {
  newContext(options?: Record<string, unknown>): Promise<{ newPage(): Promise<JourneyPage> }>;
  close(): Promise<void>;
}
interface Playwright {
  readonly chromium: { launch(options: Record<string, unknown>): Promise<JourneyBrowser> };
}

interface Drive {
  readonly ready: boolean;
  readonly replies: readonly { readonly kind?: string; readonly svg?: string; readonly message?: string }[];
}

describe('fy-render shells on Cloudflare Pages', () => {
  it('should frame the sandbox shell and allow the fragment policy, from the production bundle under production headers', () =>
    retryOnLostBrowser('fy-render-pages', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange — the production build, served the way Pages serves it.
          const root = environment.paths.root;
          const dist = await viteBuild(join(root, 'vite'), DEAD_DIRECTORY);
          const shells = await shellPathsInBundle(dist);
          // One shell: an `html` block is a static fragment now, so the html shell is gone.
          should(shells).deepEqual(['/fy-render-sandbox.html']);
          const { origin } = await startPagesDev(dist, join(root, 'wrangler'), teardown);

          // Assert — the document each shell URL finally resolves to may be framed by this origin.
          // This is the line that was wrong in production: the redirect target wore `/*`.
          for (const shell of shells) {
            const response = await fetch(`${origin}${shell}`);
            const policy = response.headers.get('content-security-policy') ?? '';
            should(response.status).equal(200);
            should(policy).equal("frame-ancestors 'self'; sandbox allow-scripts");
          }

          const playwright = (await import(resolvePlaywright())) as Playwright;
          const browser = await launchChromiumWithRetry(() =>
            playwright.chromium.launch({
              args: ['--no-sandbox', '--disable-dev-shm-usage'],
              executablePath: chromeExecutable(),
              headless: true,
              timeout: 20_000,
            }),
          );
          teardown.add('fy-render chrome', async () => await closeChromeBounded(browser));
          const context = await browser.newContext({ serviceWorkers: 'block' });
          const page = await context.newPage();
          const refusals: string[] = [];
          page.on('console', message => {
            if (/Refused|frame-ancestors|Content Security Policy/u.test(message.text())) refusals.push(message.text());
          });
          // The app's own page: its origin, its policy, its document.
          await page.goto(`${origin}/app/`, { timeout: 60_000, waitUntil: 'load' });

          // Act — a diagram through the library shell, and the Trusted Types policy an html fragment's
          // sanitizer parses under, asked for on the production page.
          const mermaid = (await page.evaluate(
            drive(
              '/fy-render-sandbox.html',
              { kind: 'render-mermaid', source: 'graph TD; A[Message] --> B[Diagram];', theme: 'dark' },
              '/fy-render-mermaid.js',
            ),
          )) as Drive;
          const policies = await page.evaluate<{ fragment: string; stranger: string; raw: string }>(`(() => {
            const attempt = name => { try { trustedTypes.createPolicy(name, { createHTML: s => s }); return 'created'; } catch (e) { return 'refused'; } };
            let raw = 'assigned';
            try { document.createElement('div').innerHTML = '<b>x</b>'; } catch (e) { raw = 'refused'; }
            return { fragment: attempt('fy-fragment'), stranger: attempt('fy-stranger'), raw };
          })()`);

          // Assert — the shell announced itself and compiled; the production policy names the one
          // fragment policy, refuses any other name, and still refuses a raw string at a sink.
          should(mermaid.ready).be.true();
          should(mermaid.replies.find(reply => reply.kind === 'mermaid-svg')?.svg ?? '').match(/^<svg/u);
          should(policies).deepEqual({ fragment: 'created', raw: 'refused', stranger: 'refused' });
          should(refusals.filter(line => !/fy-stranger|TrustedHTML/u.test(line))).deepEqual([]);
        });
      } finally {
        await teardown.closeAll();
      }
    }));
});
