/**
 * THE CONSOLE SHOWS ITS TEXT, NOT THE EMPTY ROWS UNDER IT (O12 S6 / O9-12), in a real browser over a fake pane
 * (`fixtures/console-pane-scene.tsx`, the real `ConsoleSurface`).
 *
 * A live capture is the whole pane, so a quiet agent's text ends in a run of blank rows. The pane follows the tail, so it used to
 * land on those blank rows: in Wrap a tall pane showed the first line cut in half under the header with an empty band below the last
 * line, and a short one (768 / 800 wide, a ~100px pane) opened on nothing at all. The last line of text must sit at the bottom of the
 * pane, and a pane tall enough for all the text must start it whole at the top.
 *
 * Set `FY_CONSOLE_PANE_SHOTS_DIR` to keep `<name>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CONSOLE_PANE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-console-pane-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/console-pane-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the console scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg" style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** The Console's box in a workspace of that width and height: the side panel at 1440, the panel under the chat at 768 / 800. */
const VARIANTS = [
  { name: '1440-side', w: 366, h: 640, scheme: 'light', phone: false },
  { name: '1440-side-dark', w: 366, h: 640, scheme: 'dark', phone: false },
  { name: '800-under-chat', w: 528, h: 240, scheme: 'light', phone: false },
  { name: '768-under-chat-dark', w: 496, h: 240, scheme: 'dark', phone: false },
  { name: '390-phone', w: 358, h: 560, scheme: 'light', phone: true },
  { name: '390-phone-dark', w: 358, h: 560, scheme: 'dark', phone: true },
] as const;

interface Reading {
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly firstLineTop: number;
  readonly lastTextBottom: number;
  readonly scrollTop: number;
  readonly overflows: boolean;
  readonly text: string;
}

describe('the Console pane over a capture that ends in blank rows', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: it follows the tail with no empty band, or starts whole at the top`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.w, height: variant.h },
        colorScheme: variant.scheme,
        deviceScaleFactor: variant.phone ? 2 : 1,
      });
      const tab = await context.newPage();
      tab.setDefaultTimeout(8_000);
      try {
        await tab.goto(`${server?.url.origin}/?theme=studio-${variant.scheme}&w=${variant.w}&h=${variant.h}`);
        await tab.waitForFunction(() => '__console' in window);
        await tab.waitForTimeout(600);
        const reading = await tab.evaluate((): Reading => {
          const scroller = document.querySelector('[data-testid="terminal-snapshot-scroller"]') as HTMLElement;
          const pre = scroller.querySelector('pre') as HTMLElement;
          const rect = scroller.getBoundingClientRect();
          const characters = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
          const nodes: Text[] = [];
          for (let node = characters.nextNode(); node !== null; node = characters.nextNode()) nodes.push(node as Text);
          const rangeOf = (node: Text, from: number, to: number): DOMRect => {
            const range = document.createRange();
            range.setStart(node, from);
            range.setEnd(node, to);
            return range.getBoundingClientRect();
          };
          const lastNode = [...nodes].reverse().find(node => node.data.trim() !== '') as Text;
          const lastChar = lastNode.data.trimEnd().length;
          const firstNode = nodes.find(node => node.data.trim() !== '') as Text;
          return {
            viewportTop: rect.top,
            viewportBottom: rect.bottom,
            firstLineTop: rangeOf(firstNode, 0, 1).top,
            lastTextBottom: rangeOf(lastNode, lastChar - 1, lastChar).bottom,
            scrollTop: scroller.scrollTop,
            overflows: scroller.scrollHeight > scroller.clientHeight + 1,
            text: pre.textContent ?? '',
          };
        });
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}.png`) });
        const free = reading.viewportBottom - reading.lastTextBottom;
        expect(free, `the last line is inside the pane: ${JSON.stringify(reading)}`).toBeGreaterThanOrEqual(0);
        // Text longer than the pane follows the tail: its last line sits at the bottom, no empty band under it.
        if (reading.overflows)
          expect(free, `empty band under the last line: ${JSON.stringify(reading)}`).toBeLessThanOrEqual(16);
        // Text that fits starts whole at the top: nothing scrolled away, no half-cut first line.
        else {
          expect(reading.scrollTop, `nothing is scrolled away: ${JSON.stringify(reading)}`).toBe(0);
          expect(
            reading.firstLineTop,
            `the first line starts whole: ${JSON.stringify(reading)}`,
          ).toBeGreaterThanOrEqual(reading.viewportTop);
        }
      } finally {
        await context.close();
      }
    });
  }
});
