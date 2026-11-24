/**
 * r11 S9 in a real browser: the Projects list reads as CARDS you can click, and "Discovered from ferrets" sits below as
 * one closed line.
 *
 * The owner's line: "i couldn't tell that was a project" (a project was a bare text line). Fake daemon, no network.
 * Set `FY_PROJECT_CARDS_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PROJECT_CARDS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-project-cards-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/project-cards-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

const withTab = async (
  viewport: Viewport,
  scheme: 'light' | 'dark',
  query: string,
  run: (tab: Page, shot: (name: string) => Promise<void>) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const shot = async (name: string): Promise<void> => {
    if (shotsDir !== '')
      await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
  };
  try {
    await tab.goto(`${origin}/?theme=studio-${scheme}&${query}`);
    await tab.waitForSelector('[data-scene-ready] h1', { timeout: 15_000 });
    await tab.waitForTimeout(250);
    await run(tab, shot);
  } finally {
    await context.close();
  }
};

describe('the Projects list reads as cards', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws each project as a clickable card with its own start (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, 'projects=2&discoveries=2', async (tab, shot) => {
          await shot('cards');

          const cards = await tab.evaluate(() => {
            // The bare spots of the actions row: the gap between Open and Start, and the empty area beside Start. A click
            // on either must reach the project's link (the card face), never an invisible wrapper; the buttons stay buttons.
            const hrefAt = (x: number, y: number) =>
              document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href') ?? null;
            const bareSpots = (card: Element) => {
              const buttons = [...card.querySelectorAll('.fy-pc__actions .kt-btn')];
              const [open, start] = buttons.map(button => button.getBoundingClientRect());
              const actions = card.querySelector('.fy-pc__actions')?.getBoundingClientRect();
              const middle = (open?.top ?? 0) + (open?.height ?? 0) / 2;
              const gapX = ((open?.right ?? 0) + (start?.left ?? 0)) / 2;
              const roomX = ((start?.right ?? 0) + (actions?.right ?? 0)) / 2;
              return {
                gapWidth: (start?.left ?? 0) - (open?.right ?? 0),
                roomWidth: (actions?.right ?? 0) - (start?.right ?? 0),
                hitGap: hrefAt(gapX, middle),
                hitRoom: hrefAt(roomX, middle),
                gapTarget: document.elementFromPoint(gapX, middle)?.className ?? '',
                hitOpen: hrefAt((open?.left ?? 0) + (open?.width ?? 0) / 2, middle),
                hitStart:
                  document.elementFromPoint((start?.left ?? 0) + (start?.width ?? 0) / 2, middle)?.closest('button') !==
                  null,
              };
            };
            return [...document.querySelectorAll('[data-project-card]')].map(card => {
              const style = getComputedStyle(card);
              const box = card.getBoundingClientRect();
              const border = ['Top', 'Right', 'Bottom', 'Left'].map(
                side => Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0,
              );
              const hit = (x: number, y: number) =>
                document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href') ?? null;
              const start = [...card.querySelectorAll('button, a')].find(
                el => el.textContent?.trim() === 'Start a ferret here',
              );
              const startBox = start?.getBoundingClientRect();
              // The card's own left padding area and the middle of its title line must both land on the project's link.
              return {
                name: card.getAttribute('data-project-card'),
                width: box.width,
                top: box.top,
                bottom: box.bottom,
                left: box.left,
                right: box.right,
                bordered: Math.max(...border) > 0 || style.boxShadow !== 'none',
                cursor: style.cursor,
                icon: card.querySelectorAll('svg').length,
                text: (card as HTMLElement).innerText,
                hitTitle: hit(box.left + 8, box.top + 8),
                hitBody: hit(box.left + box.width / 2 - 40, box.top + box.height / 2),
                hasLink: card.querySelector('a[href*="/projects/"]') !== null,
                startName: start?.textContent?.trim() ?? null,
                startWidth: startBox?.width ?? 0,
                startHeight: startBox?.height ?? 0,
                startRight: startBox?.right ?? 0,
                ...bareSpots(card),
              };
            });
          });
          const page = await tab.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }));
          console.info(
            `[s9] ${viewport.name} ${scheme}: ${cards.length} cards, widths ${cards.map(card => card.width.toFixed(0)).join('/')}, start ${cards.map(card => `${card.startWidth.toFixed(1)}x${card.startHeight.toFixed(0)}`).join('/')}, scrollWidth ${page.scrollWidth} <= ${page.clientWidth}`,
          );
          console.info(
            `[s9] ${viewport.name} ${scheme}: bare spots gap ${cards.map(card => card.gapWidth.toFixed(0)).join('/')}px hit ${cards.map(card => (card.hitGap === null ? 'wrapper' : 'link')).join('/')}, room ${cards.map(card => card.roomWidth.toFixed(0)).join('/')}px hit ${cards.map(card => (card.hitRoom === null ? 'wrapper' : 'link')).join('/')}`,
          );
          expect(cards, 'two projects, two cards').toHaveLength(2);
          for (const card of cards) {
            expect(card.bordered, `${card.name} has a border or shadow`).toBe(true);
            expect(card.cursor, `${card.name} shows it is clickable`).toBe('pointer');
            expect(card.icon, `${card.name} has an icon`).toBeGreaterThanOrEqual(1);
            expect(card.text).toContain(card.name as string);
            expect(card.hasLink, `${card.name} has a link to its page`).toBe(true);
            expect(card.hitTitle, 'the card face is the link').toContain('/projects/');
            expect(card.hitBody, 'the card body is the link').toContain('/projects/');
            expect(
              card.hitGap ?? `(hit ${card.gapTarget})`,
              `${card.name}: the gap between Open and Start (${card.gapWidth}px) is the card face, hit ${card.gapTarget}`,
            ).toContain('/projects/');
            if (card.roomWidth > 8)
              expect(
                card.hitRoom ?? '(not the link)',
                `${card.name}: the empty area beside Start (${card.roomWidth.toFixed(0)}px) is the card face`,
              ).toContain('/projects/');
            expect(card.hitOpen ?? '(not the link)', 'Open still goes to the project page').toContain('/projects/');
            expect(card.hitStart, 'Start is still the button').toBe(true);
            expect(card.startName).toBe('Start a ferret here');
            expect(card.startHeight, 'a touch target').toBeGreaterThanOrEqual(44);
            // Q6 (ruling C-6): content-sized with a 136px minimum on every screen, never stretched, the label on ONE line.
            expect(card.startWidth, 'Start grows to its label, never narrower than 136px').toBeGreaterThanOrEqual(135);
            expect(card.startRight, 'inside the card').toBeLessThanOrEqual(card.right);
          }
          {
            // Q6: every label on ONE line at 390 and 1440, and on a phone the buttons are NOT stretched to the card.
            const row = await tab.evaluate(() =>
              [...document.querySelectorAll('[data-project-card]')].map(card => {
                const buttons = [...card.querySelectorAll('.kt-btn')];
                const boxes = buttons.map(button => button.getBoundingClientRect());
                const lines = buttons.map(label => {
                  const range = document.createRange();
                  range.selectNodeContents(label);
                  const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight) || 18;
                  return Math.round(range.getBoundingClientRect().height / lineHeight);
                });
                const inner = card.getBoundingClientRect();
                return {
                  widths: boxes.map(box => box.width),
                  rightGap: inner.right - (boxes.at(-1)?.right ?? 0),
                  cardWidth: inner.width,
                  labelLines: lines,
                };
              }),
            );
            console.info(
              `[s9] ${viewport.name} ${scheme}: action widths ${row.map(r => r.widths.map(w => w.toFixed(0)).join('+')).join(' | ')}, right gap ${row.map(r => r.rightGap.toFixed(0)).join('/')}, label lines ${row.map(r => r.labelLines.join('+')).join(' | ')}`,
            );
            for (const card of row) {
              for (const lines of card.labelLines) expect(lines, 'every label is one line').toBe(1);
              for (const width of card.widths)
                expect(width, 'Open and Start keep the 136px minimum').toBeGreaterThanOrEqual(135);
              if (viewport.phone) {
                for (const width of card.widths)
                  expect(width, 'content-sized: narrower than the card').toBeLessThan(card.cardWidth - 28 - 20);
                expect(card.rightGap, 'the actions are not stretched to the card edge').toBeGreaterThan(16);
              }
            }
          }
          // The meta line: the repository when known, the active ferret count when there is one; the path is a tooltip only.
          expect(cards[0]?.text).toContain('fake-org/site');
          expect(cards[1]?.text).toContain('2 ferrets');
          expect(cards[0]?.text).not.toContain('/fake/p1');
          if (viewport.phone) {
            expect(cards[1]?.top, 'one column on a phone').toBeGreaterThanOrEqual((cards[0]?.bottom ?? 0) - 1);
          } else {
            expect(Math.abs((cards[0]?.top ?? 0) - (cards[1]?.top ?? 1)), '2 columns on a desktop').toBeLessThanOrEqual(
              1,
            );
          }
          expect(page.scrollWidth, 'no sideways scroll').toBeLessThanOrEqual(page.clientWidth);

          // Hover changes the card.
          const first = tab.locator('[data-project-card]').first();
          const before = await first.evaluate(card => {
            const style = getComputedStyle(card);
            return `${style.backgroundColor}|${style.boxShadow}|${style.borderColor}`;
          });
          if (!viewport.phone) {
            await first.hover({ position: { x: 8, y: 8 } });
            await tab.waitForTimeout(250);
            const after = await first.evaluate(card => {
              const style = getComputedStyle(card);
              return `${style.backgroundColor}|${style.boxShadow}|${style.borderColor}`;
            });
            expect(after, 'hover changes the card').not.toBe(before);
            await shot('card-hover');
          }

          // Clicking the card navigates in-app to the project page; "Start a ferret here" goes to New ferret.
          await first.click({ position: { x: 8, y: 8 } });
          await tab.getByRole('button', { name: 'Start a ferret here' }).nth(1).click();
          const navigated = await tab.evaluate(() => (window as unknown as { __navigated: string[] }).__navigated);
          expect(navigated[0]).toMatch(/\/projects\/00000000-0000-4000-8000-000000000001$/u);
          expect(navigated.at(-1)).toBe('/d/fake/new?folder=%2Ffake%2Fp2');
        }));

  for (const viewport of VIEWPORTS)
    it(`puts the discoveries below the cards as one closed line (${viewport.name})`, () =>
      withTab(viewport, 'light', 'projects=2&discoveries=2', async (tab, shot) => {
        const geometry = await tab.evaluate(() => {
          const details = document.querySelector('[data-project-discoveries]');
          const summary = details?.querySelector('summary');
          const cards = [...document.querySelectorAll('[data-project-card]')];
          const last = cards.at(-1)?.getBoundingClientRect();
          const line = summary === null || summary === undefined ? null : getComputedStyle(summary);
          return {
            tag: details?.tagName ?? null,
            open: (details as HTMLDetailsElement | null)?.open ?? null,
            top: details?.getBoundingClientRect().top ?? -1,
            lastBottom: last?.bottom ?? 0,
            // The LABEL's height (the summary itself is a 44px touch target on a phone): one line of text, not two.
            summaryHeight: summary?.querySelector('span')?.getBoundingClientRect().height ?? 0,
            lineHeight:
              line === null ? 0 : Number.parseFloat(line.lineHeight) || Number.parseFloat(line.fontSize) * 1.4,
            summaryText: summary?.textContent?.trim() ?? '',
            body: document.body.innerText,
          };
        });
        console.info(
          `[s9] ${viewport.name}: discoveries ${geometry.tag} open=${geometry.open} top ${geometry.top.toFixed(0)} > last card bottom ${geometry.lastBottom.toFixed(0)}, summary ${geometry.summaryHeight.toFixed(0)}px (line ${geometry.lineHeight.toFixed(1)}): "${geometry.summaryText}"`,
        );
        expect(geometry.tag).toBe('DETAILS');
        expect(geometry.open, 'closed by default').toBe(false);
        expect(geometry.top, 'below the last card').toBeGreaterThan(geometry.lastBottom);
        expect(geometry.summaryHeight, 'a one-line summary').toBeLessThanOrEqual(geometry.lineHeight * 1.6);
        expect(geometry.summaryText).toContain('Folders ferrets used, not yet projects (2)');
        expect(geometry.body).not.toContain('Ferretry registers none of them on its own');
        await shot('discoveries-closed');
        await tab.locator('[data-project-discoveries] summary').click();
        await tab.waitForSelector('[data-project-discovery]');
        expect(await tab.locator('[data-project-discovery]').count()).toBe(2);
        await shot('discoveries-open');
      }));

  it('draws no discoveries section when there are none, and keeps cards without a sideways scroll', () =>
    withTab(VIEWPORTS[1], 'dark', 'projects=2&discoveries=0', async tab => {
      expect(await tab.locator('[data-project-discoveries]').count()).toBe(0);
      const width = await tab.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(width[0]).toBeLessThanOrEqual(width[1] as number);
    }));
});
