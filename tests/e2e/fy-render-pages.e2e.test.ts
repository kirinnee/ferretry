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
 * the requested path itself.
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

interface Drive {
  readonly ready: boolean;
  readonly replies: readonly { readonly kind?: string; readonly svg?: string; readonly message?: string }[];
}

describe('fy-render shells on Cloudflare Pages', () => {
  it('should frame both sandbox shells from the production bundle under production headers', () =>
    retryOnLostBrowser('fy-render-pages', async () => {
      const teardown = harnessTeardown();
      try {
        await withE2eEnvironment(async environment => {
          // Arrange — the production build, served the way Pages serves it.
          const root = environment.paths.root;
          const dist = await viteBuild(join(root, 'vite'), DEAD_DIRECTORY);
          const shells = await shellPathsInBundle(dist);
          should(shells).deepEqual(['/fy-render-html.html', '/fy-render-sandbox.html']);
          const { origin } = await startPagesDev(dist, join(root, 'wrangler'), teardown);

          // Assert — the document each shell URL finally resolves to may be framed by this origin.
          // This is the line that was wrong in production: the redirect target wore `/*`.
          for (const shell of shells) {
            const response = await fetch(`${origin}${shell}`);
            const policy = response.headers.get('content-security-policy') ?? '';
            should(response.status).equal(200);
            should(policy).equal("frame-ancestors 'self'; sandbox allow-scripts");
          }

          const playwright = (await import(resolvePlaywright())) as typeof import('playwright-core');
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

          // Act — a diagram through the library shell, and a page through the html shell.
          const mermaid = (await page.evaluate(
            drive(
              '/fy-render-sandbox.html',
              { kind: 'render-mermaid', source: 'graph TD; A[Message] --> B[Diagram];', theme: 'dark' },
              '/fy-render-mermaid.js',
            ),
          )) as Drive;
          const html = (await page.evaluate(
            drive(
              '/fy-render-html.html',
              {
                kind: 'render-html',
                paint: null,
                source: '<p id="ok">ran</p><script>document.getElementById("ok").textContent = "ran script";</script>',
                theme: 'dark',
              },
              null,
            ),
          )) as Drive;

          // Assert — both shells announced themselves and did their work.
          should(mermaid.ready).be.true();
          should(mermaid.replies.find(reply => reply.kind === 'mermaid-svg')?.svg ?? '').match(/^<svg/u);
          should(html.ready).be.true();
          should(html.replies.some(reply => reply.kind === 'rendered')).be.true();
          should(refusals).deepEqual([]);
        });
      } finally {
        await teardown.closeAll();
      }
    }));
});
