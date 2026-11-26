/**
 * A STEPPED MERMAID DIAGRAM IN AN OLD MESSAGE KEEPS ITS STEPS AND CAPTIONS, in a real browser, on a phone and a desktop, in light and
 * dark (U1 review, item 3; decision D2 says an old diagram "loses nothing").
 *
 * The scene (`fixtures/hypermedia-mermaid-steps-scene.tsx`) is the REAL `Transcript` over one fake exchange; Durian's stylesheet is built
 * by its own script and added to the page. What is measured: the caption and the count of each step, Back off on the first and Next off on
 * the last, one step drawn when first shown and no redraw on the way back, only the active step visible, the controls inside the message
 * and nothing scrolling sideways at 390 px. Set `FY_HYPERMEDIA_SHOTS_DIR` to keep `<viewport>-<scheme>-step<n>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_HYPERMEDIA_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

/** Durian's stylesheet, built the way the app's Vite plugin builds it, then the app's theme for it. */
const durianCss = async (): Promise<string> => {
  const root = dirname(
    createRequire(join(packageRoot, '../../../package.json')).resolve('durian-markdown/package.json'),
  );
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return `${buildCss()}\n${await readFile(join(packageRoot, '../../../app/hypermedia/dh-theme.css'), 'utf8')}\n${await readFile(join(packageRoot, '../../../app/hypermedia/hypermedia.css'), 'utf8')}`;
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-mermaid-steps-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/hypermedia-mermaid-steps-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the mermaid steps scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const [{ css, js }, durian] = await Promise.all([build(), durianCss()]);
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${durian}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 1_100 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  name: (typeof VIEWPORTS)[number]['name'],
  scheme: 'light' | 'dark',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}`);
  await tab.waitForSelector('.fy-hm-mermaid-steps .ctl');
  return { tab, close: async () => await context.close() };
};

const state = async (tab: Page) =>
  await tab.evaluate(() => {
    const group = document.querySelector('.fy-hm-mermaid-steps') as HTMLElement;
    const visible = [...group.querySelectorAll<HTMLElement>('.fy-hm-mermaid-step')].filter(step =>
      step.checkVisibility({ visibilityProperty: true }),
    );
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('.ctl .btn')];
    return {
      caption:
        [...group.querySelectorAll('.dh-step-title > span')].find(span => !span.classList.contains('dh-step-hidden'))
          ?.textContent ?? '',
      count: group.querySelector('.ctl-count')?.textContent ?? '',
      visibleSteps: visible.length,
      back: buttons[0]?.disabled,
      next: buttons.at(-1)?.disabled,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      groupWidth: group.getBoundingClientRect().width,
      messageWidth: (group.closest('.dh-doc') as HTMLElement).getBoundingClientRect().width,
      images: group.querySelectorAll('img').length,
      asked: window.__asked.length,
      controlsInside:
        (group.querySelector('.ctl') as HTMLElement).getBoundingClientRect().right <=
        (group.closest('.dh-doc') as HTMLElement).getBoundingClientRect().right + 1,
      unstepped: document.querySelectorAll('.dh-doc [data-fy-mermaid]:not(:has(.fy-hm-mermaid-steps)) .ctl').length,
    };
  });

declare global {
  interface Window {
    __asked: string[];
  }
}

describe('a stepped mermaid diagram in an old message', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`shows each step’s caption and controls, and draws a step when it is first shown (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme);
        try {
          const first = await state(tab);
          expect(first.caption).toBe('The browser asks the daemon');
          expect(first.count).toBe('1 / 3');
          expect(first.back).toBe(true);
          expect(first.next).toBe(false);
          expect(first.visibleSteps).toBe(1);
          expect(first.images).toBe(1);
          // One step drawn, and the diagram with no steps beside it: two asks, no more.
          expect(first.asked).toBe(2);
          expect(first.overflow).toBeLessThanOrEqual(0);
          expect(first.groupWidth).toBeLessThanOrEqual(first.messageWidth + 1);
          expect(first.controlsInside).toBe(true);
          // The diagram with no steps has no controls of its own.
          expect(first.unstepped).toBe(0);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-step1.png`) });

          await tab.click('.fy-hm-mermaid-steps .btn-go');
          const second = await state(tab);
          expect(second.caption).toBe('The daemon asks the relay when the browser is far away');
          expect(second.count).toBe('2 / 3');
          expect(second.back).toBe(false);
          expect(second.visibleSteps).toBe(1);
          expect(second.images).toBe(2);
          expect(second.asked).toBe(3);

          await tab.click('.fy-hm-mermaid-steps .btn-go');
          const third = await state(tab);
          expect(third.caption).toBe('The relay answers the browser, and the story ends');
          expect(third.count).toBe('3 / 3');
          expect(third.next).toBe(true);
          expect(third.overflow).toBeLessThanOrEqual(0);
          expect(third.asked).toBe(4);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-step3.png`) });

          // Back to the first: nothing is drawn again.
          await tab.click('.fy-hm-mermaid-steps .ctl .btn:not(.btn-go)');
          await tab.click('.fy-hm-mermaid-steps .ctl .btn:not(.btn-go)');
          const again = await state(tab);
          expect(again.caption).toBe('The browser asks the daemon');
          expect(again.asked).toBe(4);
          const asked = await tab.evaluate(() => window.__asked);
          // In the order they were first shown: step 1, the diagram with no steps, step 2, step 3.
          expect(asked[0]).toContain('Browser --> Daemon');
          expect(asked[0]).not.toContain('Daemon --> Relay');
          expect(asked[1]).toContain('Plan --> Build');
          expect(asked[2]).toContain('Daemon --> Relay');
          expect(asked[2]).toContain('Browser --> Daemon');
          expect(asked[2]).not.toContain('Relay --> Browser');
          expect(asked[3]).toContain('Relay --> Browser');
          for (const body of asked) expect(body).not.toContain('@step');
        } finally {
          await close();
        }
      });
});
