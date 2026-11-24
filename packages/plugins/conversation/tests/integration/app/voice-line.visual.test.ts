/**
 * A SPOKEN LINE OF A REPLY (`<voice>…</voice>`) READS DIFFERENTLY FROM WRITTEN WORDS, in a real browser, on a phone and a
 * desktop, in light and dark. The scene (`fixtures/voice-line-scene.tsx`) is the REAL `Transcript`. Measured:
 *   - each spoken line is drawn as a speaker line (a mark, a soft accent outline, a tint) and no raw tag shows;
 *   - the tint is not the message's: the line's background differs from the page and from a paragraph's;
 *   - the line wraps inside the message and nothing scrolls sideways at 390 px;
 *   - the words keep contrast against the line's own tint (>= 4.5:1);
 *   - a reply that only SHOWS the tag in code draws no speaker line and keeps the tag as text.
 *
 * Set `FY_VOICE_SHOTS_DIR` to keep `<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

const durianCss = async (): Promise<string> => {
  const root = dirname(
    createRequire(join(packageRoot, '../../../package.json')).resolve('durian-hypermedia/package.json'),
  );
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return `${buildCss()}\n${await readFile(join(packageRoot, '../../../app/hypermedia/dh-theme.css'), 'utf8')}`;
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-line-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-line-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the voice-line scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '390', viewport: { width: 390, height: 1_100 }, deviceScaleFactor: 2, phone: true },
  { name: '1440', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1, phone: false },
] as const;

const open = async (
  viewport: (typeof VIEWPORTS)[number],
  scheme: 'light' | 'dark',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}`);
  await tab.waitForSelector('[data-fy-voice-line]');
  // The first answer's prose is read in a worker: wait until its terminal is drawn.
  await tab.waitForSelector('.dh-doc .term');
  await tab.waitForFunction(
    () => document.querySelector('.dh-doc .term-body')?.textContent?.includes('ok 12 tests') === true,
  );
  return { tab, close: async () => await context.close() };
};

const measure = async (tab: Page) =>
  await tab.evaluate(() => {
    const parse = (colour: string): [number, number, number] => {
      const [r = 0, g = 0, b = 0] = (colour.match(/[\d.]+/gu) ?? []).map(Number);
      return [r, g, b];
    };
    const channel = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: [number, number, number]): number =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const contrast = (a: string, b: string): number => {
      const [high, low] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
    };
    const lines = [...document.querySelectorAll<HTMLElement>('[data-fy-voice-line]')];
    const first = lines[0] as HTMLElement;
    const words = first.querySelector('.fy-voice-line__words') as HTMLElement;
    const style = getComputedStyle(first);
    const paragraph = document.querySelector('.dh-doc p') as HTMLElement;
    const message = first.parentElement as HTMLElement;
    const log = document.querySelector('.fy-chat-log') as HTMLElement;
    return {
      lines: lines.map(line => line.querySelector('.fy-voice-line__words')?.textContent ?? ''),
      rail: style.borderTopWidth,
      railColour: style.borderTopColor,
      tint: style.backgroundColor,
      pageTint: getComputedStyle(document.body).backgroundColor,
      paragraphTint: getComputedStyle(paragraph).backgroundColor,
      markShown:
        (first.querySelector('svg.fy-voice-line__mark') as SVGElement | null)?.getBoundingClientRect().width ?? 0,
      contrast: contrast(getComputedStyle(words).color, style.backgroundColor),
      lineRight: first.getBoundingClientRect().right,
      messageRight: message.getBoundingClientRect().right,
      logRight: log.getBoundingClientRect().right,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      rawTag: (document.querySelector('.fy-chat-log__messages')?.textContent ?? '').includes('<voice>Let me'),
      teachingKeepsTag: (document.querySelector('.fy-chat-log__messages')?.textContent ?? '').includes(
        '<voice>hello</voice>',
      ),
      lineCount: lines.length,
    };
  });

describe('a spoken line in a chat reply', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`is drawn as a speaker line (${viewport.name}, ${scheme})`, async () => {
        const { tab, close } = await open(viewport, scheme);
        try {
          const m = await measure(tab);
          expect(m.lines).toEqual([
            'Let me check the build.',
            'All twelve tests pass and the build is green, so it is safe to ship whenever you are ready to go ahead.',
          ]);
          expect(m.lineCount).toBe(2);
          expect(m.rail).toBe('1px');
          expect(m.tint).not.toBe(m.pageTint);
          expect(m.tint).not.toBe(m.paragraphTint);
          expect(m.markShown).toBeGreaterThan(8);
          expect(m.contrast).toBeGreaterThanOrEqual(4.5);
          expect(m.lineRight).toBeLessThanOrEqual(m.logRight + 1);
          expect(m.overflow).toBeLessThanOrEqual(0);
          expect(m.rawTag).toBe(false);
          expect(m.teachingKeepsTag).toBe(true);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}.png`) });
        } finally {
          await close();
        }
      });
});
