/**
 * AN AGENDA ITEM IS DRAWN AS DURIAN HYPERMEDIA, in a real browser, on a phone and a desktop, in light and dark (r12 H10).
 *
 *  - An item whose body holds a ` ```terminal ` part draws the part (Durian's terminal, its lines in the page), and a
 *    reference in it (`&F12`) reads as the plain text it is: the inbox has no reference surface to prove it with.
 *  - The card does not change size for the swap: a text-only item is as tall drawn by Durian as by the shell's Markdown
 *    (the baseline, `?plain=1`), so a card, and the swipe deck of them, keeps the height it had. A heading the ferret
 *    wrote in a segment is still a bold line at the segment's size, never an h1–h6.
 *
 * The scene is the REAL `AgendaItemView` with the REAL `agendaProse`, and Conversation's real app half registered as the
 * shell's surfaces (`fixtures/agenda-prose-scene.tsx`). Set `FY_AGENDA_PROSE_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENDA_PROSE_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

/** Durian's stylesheet, built the way the app's Vite plugin builds it: by the package's own script. */
const durianCss = async (): Promise<string> => {
  const root = dirname(
    createRequire(join(packageRoot, '../../../../conversation/package.json')).resolve('durian-hypermedia/package.json'),
  );
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return buildCss();
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-prose-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agenda-prose-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the prose scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const framesSettled = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_280, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  name: (typeof VIEWPORTS)[number]['name'],
  scheme: 'light' | 'dark',
  query: string,
  waitFor: string,
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
  await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
  await tab.waitForSelector(waitFor);
  // Every animation that ends has ended (the page's slide-in); a terminal's blinking cursor never does and is left alone.
  await tab.evaluate(
    async () =>
      await Promise.all(
        document
          .getAnimations()
          .filter(each => each.effect?.getComputedTiming().iterations !== Infinity)
          .map(each => each.finished.catch(() => undefined)),
      ),
  );
  await framesSettled(tab);
  return { tab, close: async () => await context.close() };
};

/** How tall the item's body is laid out, and the segment boxes in it. */
interface Measured {
  /** The segment box's height, and the size and weight of the first text block inside it. */
  readonly segments: readonly {
    readonly top: number;
    readonly left: number;
    readonly height: number;
    readonly size: string;
    readonly weight: string;
    readonly blocks: readonly string[];
  }[];
  /** Where the last segment ends: the card's content, however tall its scroller is. */
  readonly end: number;
}
const measure = async (tab: Page): Promise<Measured> =>
  await tab.evaluate(() => {
    const boxes = [...document.querySelectorAll('.fy-item-view__body .fy-seg')] as HTMLElement[];
    // Everything is read from the card's own column: the page may still be sliding it in by a pixel or two.
    const column = (document.querySelector('.fy-item-view__column') as HTMLElement).getBoundingClientRect().top;
    return {
      segments: boxes.map(box => {
        const text = (box.querySelector('p, li') ?? box) as HTMLElement;
        const style = getComputedStyle(text);
        // What the segment is made of, block by block: where a difference between the two draws comes from.
        const blocks = [...(box.querySelector('.dh-doc') ?? box).children].map(child => {
          const own = getComputedStyle(child);
          return `${child.tagName.toLowerCase()} ${child.getBoundingClientRect().height.toFixed(1)} m${own.marginTop}/${own.marginBottom}`;
        });
        const at = box.getBoundingClientRect();
        return {
          top: at.top - column,
          left: at.left,
          height: at.height,
          size: style.fontSize,
          weight: style.fontWeight,
          blocks,
        };
      }),
      end: Math.max(...boxes.map(box => box.getBoundingClientRect().bottom)) - column,
    };
  });

describe('an agenda item drawn as Durian hypermedia', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`draws a terminal part and leaves a reference as text (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, '', '.fy-item-view__body .dh-doc .term');
        try {
          const state = await tab.evaluate(() => {
            const body = document.querySelector('.fy-item-view__body') as HTMLElement;
            return {
              terms: body.querySelectorAll('.dh-doc .term').length,
              log: body.querySelectorAll('.dh-doc .term .term-body[role="log"]').length,
              hypermedia: body.querySelectorAll('[data-fy-hypermedia]').length,
              text: body.textContent ?? '',
              links: [...body.querySelectorAll('a[data-fy-reference]')].map(each => each.textContent),
              sideways: body.scrollWidth > body.clientWidth + 1,
            };
          });
          expect(state.terms, 'the terminal part is drawn').toBe(1);
          expect(state.log, 'with its log').toBe(1);
          expect(state.hypermedia, 'every segment is hypermedia').toBeGreaterThan(0);
          expect(state.text, 'the reference is still there, as words').toContain('&F12');
          expect(state.links, 'the inbox has no reference surface: no link').toEqual([]);
          expect(state.sideways, 'the card does not scroll sideways').toBe(false);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-terminal.png`) });
        } finally {
          await close();
        }
      });

      it(`is as tall as the Markdown it replaces, and a heading stays a bold line (${name}, ${scheme})`, async () => {
        const plain = await open(name, scheme, '&text=1&plain=1', '.fy-item-view__body .md');
        const before = await measure(plain.tab);
        if (shotsDir !== '')
          await plain.tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-text-markdown.png`) });
        await plain.close();
        const { tab, close } = await open(name, scheme, '&text=1', '.fy-item-view__body [data-fy-hypermedia] .dh-doc');
        try {
          const after = await measure(tab);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-text-hypermedia.png`) });
          expect(after.segments.length, 'the same segments').toBe(before.segments.length);
          const said = `Markdown ${JSON.stringify(before)} vs hypermedia ${JSON.stringify(after)}`;
          expect(Math.abs(after.end - before.end), `the card ends where it did: ${said}`).toBeLessThanOrEqual(2);
          after.segments.forEach((segment, at) => {
            const was = before.segments[at];
            expect(
              Math.abs(segment.top - (was?.top ?? 0)),
              `segment ${String(at)} starts where it did: ${said}`,
            ).toBeLessThanOrEqual(2);
            expect(
              Math.abs(segment.left - (was?.left ?? 0)),
              `segment ${String(at)} is as far in: ${said}`,
            ).toBeLessThanOrEqual(2);
            expect(
              Math.abs(segment.height - (was?.height ?? 0)),
              `segment ${String(at)} keeps its height: ${said}`,
            ).toBeLessThanOrEqual(2);
            expect(segment.size, `segment ${String(at)} keeps its type size: ${said}`).toBe(was?.size ?? '');
            expect(segment.weight, `segment ${String(at)} keeps its weight: ${said}`).toBe(was?.weight ?? '');
          });
          const plan = await tab.evaluate(() => {
            const segment = [...document.querySelectorAll('.fy-item-view__body .fy-seg')].find(each =>
              (each.textContent ?? '').includes('First, the short'),
            ) as HTMLElement;
            const inSegments = [...segment.querySelectorAll('*')];
            // Durian's heading is an h2 holding its (hidden) anchor and the words; the Markdown's is a bold line.
            const heading = inSegments.find(
              each =>
                (each.textContent ?? '').trim().endsWith('Plan') && !each.querySelector('p, h1, h2, h3, h4, h5, h6'),
            );
            const paragraph = inSegments.find(
              each => each.tagName === 'P' && (each.textContent ?? '').startsWith('First'),
            );
            if (heading === undefined || paragraph === undefined) return { found: false, html: segment.outerHTML };
            const own = getComputedStyle(heading);
            return {
              found: true,
              size: own.fontSize,
              paragraphSize: getComputedStyle(paragraph).fontSize,
              weight: Number(own.fontWeight),
            };
          });
          expect(
            plan.found,
            `the heading and the paragraph are in the segment: ${'html' in plan ? plan.html : ''}`,
          ).toBe(true);
          if (plan.found) {
            expect(plan.size, 'a heading is drawn at the segment size').toBe(plan.paragraphSize);
            expect(plan.weight, 'and bold').toBeGreaterThanOrEqual(600);
          }
        } finally {
          await close();
        }
      });
    }
});
