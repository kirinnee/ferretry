/**
 * AN AGENDA ITEM IS DRAWN AS DURIAN HYPERMEDIA, in a real browser, on a phone and a desktop, in light and dark (r12 H10).
 *
 *  - An item whose body holds a ` ```terminal ` part draws the part (Durian's terminal, its lines in the page). A reference
 *    in it reads as the Inbox's own proof says: `&F12`, which the Board proves, is a link that opens `/board-card/F12`,
 *    and `&F99`, which it does not, is the plain text it is (docs/reference-standard.md: proved, else plain).
 *  - The card does not change size for the swap: a text-only item is as tall drawn by Durian as by the shell's Markdown
 *    (the baseline, `?plain=1`), so a card, and the REAL swipe deck holding it (the top card and the one peeking out
 *    behind it), keeps the height it had. A heading the ferret wrote in a segment is still a bold line at the segment's
 *    size, never an h1–h6: the card's own title is the heading, so an `h2` the ferret wrote would sit above it in the outline
 *    (R3: it was styled down, but it was still an `h2`).
 *  - Conversation REGISTERED but turned OFF on this machine's daemon (`?off=1`) draws the shell's Markdown, not Durian.
 *
 * The scene is the REAL Inbox page opened on an item (the real `AgendaItemView` in the real deck) with the REAL `agendaProse`,
 * the real Board proof scope over a fake Board, and Conversation's real app half registered as the shell's surfaces
 * (`fixtures/agenda-prose-scene.tsx`). Set `FY_AGENDA_PROSE_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

// The whole Inbox page is built and drawn for each case, twice for the comparisons: a loaded machine needs the room.
setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENDA_PROSE_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
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

/**
 * How far a height may differ between the two draws, in px. The real Inbox sets its text at 17px, where the one list with
 * inline code in it is 2.06px shorter drawn by Durian (52.3px) than by the Markdown (54.3px): the code's own line box.
 */
const SLACK = 3;

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
  /** The REAL swipe deck: mounted, the height of the deck and of its top card, and how many cards peek out behind it. */
  readonly deck: { readonly mounted: boolean; readonly height: number; readonly top: number; readonly peeks: number };
}
const measure = async (tab: Page): Promise<Measured> =>
  await tab.evaluate(() => {
    const boxes = [...document.querySelectorAll('.fy-attn-deck__top .fy-item-view__body .fy-seg')] as HTMLElement[];
    // Everything is read from the card's own column: the page may still be sliding it in by a pixel or two.
    const column = (
      document.querySelector('.fy-attn-deck__top .fy-item-view__column') as HTMLElement
    ).getBoundingClientRect().top;
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
      deck: {
        mounted: document.querySelector('.fy-attn-deck') !== null,
        height: document.querySelector('.fy-attn-deck')?.getBoundingClientRect().height ?? 0,
        top: document.querySelector('.fy-attn-deck__top')?.getBoundingClientRect().height ?? 0,
        peeks: document.querySelectorAll('.fy-attn-deck__peek').length,
      },
    };
  });

describe('an agenda item drawn as Durian hypermedia', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`draws a terminal part, links the reference Board proves and leaves the one it does not (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, '', '.fy-attn-deck__top .fy-item-view__body .dh-doc .term');
        try {
          const state = await tab.evaluate(() => {
            const body = document.querySelector('.fy-attn-deck__top .fy-item-view__body') as HTMLElement;
            const links = [...body.querySelectorAll('a[data-fy-reference]')] as HTMLAnchorElement[];
            return {
              terms: body.querySelectorAll('.dh-doc .term').length,
              log: body.querySelectorAll('.dh-doc .term .term-body[role="log"]').length,
              hypermedia: body.querySelectorAll('[data-fy-hypermedia]').length,
              text: body.textContent ?? '',
              links: links.map(each => [each.textContent, each.getAttribute('href')]),
              sideways: body.scrollWidth > body.clientWidth + 1,
            };
          });
          expect(state.terms, 'the terminal part is drawn').toBe(1);
          expect(state.log, 'with its log').toBe(1);
          expect(state.hypermedia, 'every segment is hypermedia').toBeGreaterThan(0);
          expect(state.text, 'the unproved reference is still there, as words').toContain('&F99');
          expect(state.links.length, 'the proved reference is a link (the context line and the body)').toBeGreaterThan(
            0,
          );
          expect(
            state.links.every(([text, href]) => text === '&F12' && (href ?? '').includes('kind=task&id=F12')),
            `every link is the proved &F12, and &F99 is none: ${JSON.stringify(state.links)}`,
          ).toBe(true);
          expect(state.sideways, 'the card does not scroll sideways').toBe(false);
          if (shotsDir !== '') {
            // The shot shows the terminal's lines (it types them in) and the line with the references, scrolled clear of the
            // card's answer bar.
            await tab.waitForFunction(() =>
              (document.querySelector('.fy-attn-deck__top .term-body[role="log"]')?.textContent ?? '').includes(
                'ok 3 tests',
              ),
            );
            await tab.evaluate(() =>
              [...document.querySelectorAll('.fy-attn-deck__top .fy-item-view__body p')]
                .find(each => (each.textContent ?? '').includes('Tracked as'))
                ?.scrollIntoView({ block: 'center' }),
            );
            await framesSettled(tab);
            await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-terminal.png`) });
          }
          // A click on it opens the task: the Board's own address.
          await tab.locator('.fy-attn-deck__top .fy-item-view__body a[data-fy-reference]').first().click();
          expect(
            await tab.evaluate(() => document.documentElement.dataset.navigated),
            'the link opens /board-card/F12',
          ).toBe('/board-card/F12');
        } finally {
          await close();
        }
      });

      it(`draws the shell Markdown when this machine's daemon has Conversation off (${name}, ${scheme})`, async () => {
        // The sentinel is the same view on a machine where Conversation is on: once it is Durian, the lazy view has loaded,
        // so a card still drawn as Markdown is held there by the daemon's standing, not by the swap not having happened yet.
        const { tab, close } = await open(name, scheme, '&off=1', '[data-sentinel] .dh-doc');
        try {
          await tab.waitForSelector('.fy-attn-deck__top .fy-item-view__body .md');
          const state = await tab.evaluate(() => {
            const body = document.querySelector('.fy-attn-deck__top .fy-item-view__body') as HTMLElement;
            return {
              hypermedia: body.querySelectorAll('[data-fy-hypermedia], .dh-doc').length,
              terms: body.querySelectorAll('.term').length,
              markdown: body.querySelectorAll('.md').length,
              text: body.textContent ?? '',
            };
          });
          expect(state.hypermedia, 'Conversation is registered but off here: no Durian').toBe(0);
          expect(state.terms, 'so the terminal is not drawn as a terminal').toBe(0);
          expect(state.markdown, 'the shell Markdown draws it').toBeGreaterThan(0);
          expect(state.text, 'and the words are there').toContain('bun test');
        } finally {
          await close();
        }
      });

      it(`keeps the swipe deck's geometry for a short card (${name}, ${scheme})`, async () => {
        // A short card, in the real deck: the deck, its top card and the card peeking behind it are drawn the same.
        const plain = await open(name, scheme, '&text=short&plain=1', '.fy-attn-deck__top .fy-item-view__body .md');
        const before = await measure(plain.tab);
        await plain.close();
        const { tab, close } = await open(
          name,
          scheme,
          '&text=short',
          '.fy-attn-deck__top .fy-item-view__body [data-fy-hypermedia] .dh-doc',
        );
        try {
          const after = await measure(tab);
          const said = `Markdown ${JSON.stringify(before)} vs hypermedia ${JSON.stringify(after)}`;
          expect(before.deck.mounted && after.deck.mounted, `the real swipe deck is mounted in both: ${said}`).toBe(
            true,
          );
          // The real deck gives its top card the room the screen has, whatever the text; a short text ends well inside it
          // in both draws, so the swap never makes a card that fitted scroll.
          expect(before.end, `the Markdown's text ends inside the top card: ${said}`).toBeLessThan(before.deck.top);
          expect(after.end, `and so does Durian's: ${said}`).toBeLessThan(after.deck.top);
          expect(Math.abs(after.end - before.end), `at the same place: ${said}`).toBeLessThanOrEqual(SLACK);
          expect(before.deck.peeks, `a card peeks out behind the top one: ${said}`).toBeGreaterThan(0);
          expect(after.deck.peeks, `and still does: ${said}`).toBe(before.deck.peeks);
          expect(
            Math.abs(after.deck.top - before.deck.top),
            `the deck's top card keeps its height: ${said}`,
          ).toBeLessThanOrEqual(SLACK);
          expect(
            Math.abs(after.deck.height - before.deck.height),
            `the deck keeps its height: ${said}`,
          ).toBeLessThanOrEqual(SLACK);
        } finally {
          await close();
        }
      });

      it(`is as tall as the Markdown it replaces, and a heading stays a bold line (${name}, ${scheme})`, async () => {
        const plain = await open(name, scheme, '&text=1&plain=1', '.fy-attn-deck__top .fy-item-view__body .md');
        const before = await measure(plain.tab);
        if (shotsDir !== '')
          await plain.tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-text-markdown.png`) });
        await plain.close();
        const { tab, close } = await open(
          name,
          scheme,
          '&text=1',
          '.fy-attn-deck__top .fy-item-view__body [data-fy-hypermedia] .dh-doc',
        );
        try {
          const after = await measure(tab);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-text-hypermedia.png`) });
          expect(after.segments.length, 'the same segments').toBe(before.segments.length);
          const said = `Markdown ${JSON.stringify(before)} vs hypermedia ${JSON.stringify(after)}`;
          expect(Math.abs(after.end - before.end), `the card ends where it did: ${said}`).toBeLessThanOrEqual(SLACK);
          // THE REAL SWIPE DECK, mounted in both draws with the same text: its height, its top card's and its peeks hold.
          expect(before.deck.mounted && after.deck.mounted, `the swipe deck is mounted in both: ${said}`).toBe(true);
          expect(after.deck.peeks, `the card behind it peeks out as it did: ${said}`).toBe(before.deck.peeks);
          expect(before.deck.peeks, `a card does peek out behind the top one: ${said}`).toBeGreaterThan(0);
          expect(
            Math.abs(after.deck.top - before.deck.top),
            `the deck's top card keeps its height: ${said}`,
          ).toBeLessThanOrEqual(SLACK);
          expect(
            Math.abs(after.deck.height - before.deck.height),
            `the deck keeps its height: ${said}`,
          ).toBeLessThanOrEqual(SLACK);
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
            ).toBeLessThanOrEqual(SLACK);
            expect(segment.size, `segment ${String(at)} keeps its type size: ${said}`).toBe(was?.size ?? '');
            expect(segment.weight, `segment ${String(at)} keeps its weight: ${said}`).toBe(was?.weight ?? '');
          });
          const plan = await tab.evaluate(() => {
            const segment = [...document.querySelectorAll('.fy-attn-deck__top .fy-item-view__body .fy-seg')].find(
              each => (each.textContent ?? '').includes('First, the short'),
            ) as HTMLElement;
            const inSegments = [...segment.querySelectorAll('*')];
            // The heading line is the innermost element that holds the words: the `strong` of the demoted `p` (the same in the
            // Markdown draw), where it used to be Durian's `h2` holding its (hidden) anchor and the words.
            const heading = inSegments
              .filter(
                each =>
                  (each.textContent ?? '').trim().endsWith('Plan') && !each.querySelector('p, h1, h2, h3, h4, h5, h6'),
              )
              .at(-1);
            const paragraph = inSegments.find(
              each => each.tagName === 'P' && (each.textContent ?? '').startsWith('First'),
            );
            if (heading === undefined || paragraph === undefined) return { found: false, html: segment.outerHTML };
            const own = getComputedStyle(heading);
            return {
              found: true,
              // The outline: the card's own labels are its headings, so no segment (words the ferret wrote) holds one.
              headings: [
                ...document.querySelectorAll(
                  '.fy-attn-deck__top .fy-item-view__body .fy-seg :is(h1, h2, h3, h4, h5, h6)',
                ),
              ].map(each => each.tagName),
              line: heading.closest('p, h1, h2, h3, h4, h5, h6')?.tagName ?? heading.tagName,
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
            expect(plan.headings, `no heading element inside a segment: ${said}`).toEqual([]);
            expect(plan.line, 'the ferret’s heading is a bold line, not a heading').toBe('P');
            expect(plan.size, 'a heading is drawn at the segment size').toBe(plan.paragraphSize);
            expect(plan.weight, 'and bold').toBeGreaterThanOrEqual(600);
          }
        } finally {
          await close();
        }
      });
    }
});
