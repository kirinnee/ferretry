/**
 * AN ASSISTANT MESSAGE READS AS DURIAN HYPERMEDIA, in a real browser, on a phone and a desktop, in light and dark.
 *
 * The scene (`fixtures/hypermedia-prose-scene.tsx`) is the REAL `Transcript` over one fake exchange. Durian's stylesheet is
 * built by its own script (`buildCss`, what the app's Vite build does) and added to the page. What is measured:
 *   - the terminal part is drawn and styled (`.dh-doc .term`: a border, a radius, a body the width of the message);
 *   - nothing scrolls sideways at 390 px;
 *   - the document takes the APP's mode (`data-mode`), so a dark app is dark whatever the system says: the light and dark
 *     terminals are different colours, and a system-dark browser in an app-light page still paints light;
 *   - a proved reference is a link and a click opens it; an unproved one is text;
 *   - every heading id of the message is unique and carries the message's prefix.
 *
 * Set `FY_HYPERMEDIA_SHOTS_DIR` to keep `<viewport>-<scheme>.png`.
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

/** Durian's stylesheet, built the way the app's Vite plugin builds it: by the package's own script. */
const durianCss = async (): Promise<string> => {
  const root = dirname(
    createRequire(join(packageRoot, '../../../package.json')).resolve('durian-hypermedia/package.json'),
  );
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return buildCss();
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-hypermedia-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/hypermedia-prose-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the hypermedia scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  // Tall enough to hold the whole fake message, so a shot shows the exchange and not its scroll position.
  { name: 'phone', viewport: { width: 390, height: 1_500 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_280, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  name: string,
  scheme: 'light' | 'dark',
  appMode: 'light' | 'dark',
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
  await tab.goto(`${origin}/?theme=studio-${appMode}`);
  await tab.waitForSelector('.dh-doc .term');
  // The terminal types its command and prints its output when it comes on screen: wait for the last line.
  await tab.waitForFunction(
    () => document.querySelector('.dh-doc .term-body')?.textContent?.includes('ok 12 tests') === true,
  );
  return { tab, close: async () => await context.close() };
};

interface Measured {
  readonly termBorder: string;
  readonly termRadius: number;
  readonly termWidth: number;
  readonly docWidth: number;
  readonly termBackground: string;
  readonly docTheme: string | null;
  readonly overflow: number;
  readonly headingIds: readonly string[];
  readonly chips: readonly string[];
  readonly tableRows: number;
  readonly codeSpans: number;
  readonly listMarker: string;
  readonly terminalText: string;
}

const measure = async (tab: Page): Promise<Measured> =>
  await tab.evaluate(() => {
    const doc = document.querySelector('.dh-doc') as HTMLElement;
    const term = document.querySelector('.dh-doc .term') as HTMLElement;
    const style = getComputedStyle(term);
    return {
      termBorder: style.borderTopWidth,
      termRadius: Number.parseFloat(style.borderTopLeftRadius),
      termWidth: term.getBoundingClientRect().width,
      docWidth: doc.getBoundingClientRect().width,
      termBackground: style.backgroundColor,
      docTheme: doc.getAttribute('data-theme'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      headingIds: [...document.querySelectorAll('.dh-doc h1,.dh-doc h2,.dh-doc h3')].map(h => h.id),
      chips: [...document.querySelectorAll('.dh-doc a[data-fy-reference]')].map(a => a.textContent ?? ''),
      tableRows: document.querySelectorAll('.dh-doc table tbody tr').length,
      codeSpans: document.querySelectorAll('.dh-doc pre code span[class^="hljs-"]').length,
      listMarker: getComputedStyle(document.querySelector('.dh-doc > ul > li') as HTMLElement).listStyleType,
      terminalText: document.querySelector('.dh-doc .term-body')?.textContent ?? '',
    };
  });

const seen = new Map<string, Measured>();

describe('an assistant message as Durian Hypermedia', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws the terminal, the table, the code and the references (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, scheme);
        try {
          const m = await measure(tab);
          seen.set(`${name}-${scheme}`, m);
          expect(m.termBorder).toBe('1px');
          expect(m.termRadius).toBeGreaterThan(0);
          expect(m.termWidth).toBeGreaterThan(200);
          expect(m.termWidth).toBeLessThanOrEqual(m.docWidth + 1);
          expect(m.overflow).toBeLessThanOrEqual(0);
          expect(m.docTheme).toBe(scheme);
          expect(m.tableRows).toBe(2);
          expect(m.codeSpans).toBeGreaterThan(0);
          expect(m.listMarker).toBe('disc');
          expect(m.terminalText).toContain('bun test');
          // `:zelda`, `^A3` and `&F12` are proved; `&F99999` and `@src/api.ts` (no file proof here) are text.
          expect(m.chips).toEqual([':zelda', '^A3', '&F12']);
          expect(new Set(m.headingIds).size).toBe(m.headingIds.length);
          expect(m.headingIds.every(id => id.startsWith('dh-'))).toBe(true);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
        } finally {
          await close();
        }
      });

  for (const { name } of VIEWPORTS)
    it(`keeps author text visible and inline code literal (${name})`, async () => {
      const { tab, close } = await open(name, 'light', 'light');
      try {
        const m = await tab.evaluate(() => {
          const details = document.querySelector('.dh-doc details[data-fy-llm-only]') as HTMLDetailsElement;
          const summary = details.querySelector('summary') as HTMLElement;
          const box = summary.getBoundingClientRect();
          const human = document.querySelector('.dh-doc section.human') as HTMLElement;
          return {
            disclosures: document.querySelectorAll('.dh-doc details[data-fy-llm-only]').length,
            open: details.open,
            summary: summary.textContent,
            summaryWidth: box.width,
            summaryHeight: box.height,
            preShown: (details.querySelector('pre') as HTMLElement).checkVisibility(),
            humanText: human.textContent,
            humanHeight: human.getBoundingClientRect().height,
            spans: [...document.querySelectorAll('.dh-doc p code')].map(c => c.textContent),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(m.disclosures).toBe(1);
        expect(m.open).toBe(false);
        expect(m.summary).toBe('LLM-only text');
        expect(m.summaryWidth).toBeGreaterThan(40);
        expect(m.summaryHeight).toBeGreaterThan(10);
        expect(m.preShown).toBe(false);
        expect(m.humanText).toContain('Only people read this line.');
        expect(m.humanHeight).toBeGreaterThan(10);
        expect(m.spans).toEqual(['&lt;demo&gt;', '<demo>']);
        expect(m.overflow).toBeLessThanOrEqual(0);
        await tab.click('.dh-doc details[data-fy-llm-only] summary');
        const opened = await tab.evaluate(() => {
          const pre = document.querySelector('.dh-doc details[data-fy-llm-only] pre') as HTMLElement;
          return {
            shown: pre.checkVisibility(),
            text: pre.textContent,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(opened).toEqual({ shown: true, text: 'Tests pass: 12 of 12.', overflow: opened.overflow });
        expect(opened.overflow).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    });

  it('opens what a click on a proved reference asks for, and nothing for text', async () => {
    const { tab, close } = await open('desktop', 'light', 'light');
    try {
      await tab.click('.dh-doc a[data-fy-reference]:text("&F12")');
      await tab.click('.dh-doc a[data-fy-reference]:text("^A3")');
      expect(await tab.evaluate(() => window.__opened)).toEqual(['task:F12', 'attention:A3']);
      expect(await tab.locator('.dh-doc').first().textContent()).toContain('&F99999');
    } finally {
      await close();
    }
  });

  it('follows the app, not the system: a dark system in a light app paints light, and the reverse', async () => {
    for (const [system, app] of [
      ['dark', 'light'],
      ['light', 'dark'],
    ] as const) {
      const { tab, close } = await open('desktop', system, app);
      try {
        expect((await measure(tab)).docTheme).toBe(app);
        seen.set(`system-${system}-app-${app}`, await measure(tab));
      } finally {
        await close();
      }
    }
    expect(seen.get('system-dark-app-light')?.termBackground).toBe(seen.get('desktop-light')?.termBackground as string);
    expect(seen.get('system-light-app-dark')?.termBackground).toBe(seen.get('desktop-dark')?.termBackground as string);
    expect(seen.get('desktop-light')?.termBackground).not.toBe(seen.get('desktop-dark')?.termBackground as string);
  });
});
