/**
 * THE EXAGGERATED-MINIMALISM SPECIMEN (r10 T14) in a real browser over fake data. It reuses the Neo specimen page (every
 * component family the app draws, `fixtures/neo-specimen-scene.tsx`, which takes `?style=`) and holds the style to its own
 * promise on any palette and either mode, at 1280 and 390 wide: no rounded corner, no shadow, a hair-thin large title (never over 3.25rem)
 * scale, doubled air, and the two checks every style must pass (no horizontal overflow, a drawn keyboard ring).
 *
 * Set `FY_EXAGGERATED_SHOTS_DIR` to keep `<width>-<palette>-<mode>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_EXAGGERATED_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-exaggerated-specimen-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/neo-specimen-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the specimen scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const WIDTHS = [
  { width: 1_280, height: 900, phone: false },
  { width: 390, height: 1_840, phone: true },
] as const;
const PALETTES = ['studio', 'neo', 'hacker'] as const;
const MODES = ['light', 'dark'] as const;

describe('the Exaggerated Minimalism specimen', () => {
  for (const width of WIDTHS)
    for (const palette of PALETTES)
      for (const mode of MODES) {
        const name = `${width.width}-${palette}-${mode}`;
        it(`${name}: no overflow, no radius, no shadow, a hair-thin huge title scale, doubled air, a keyboard ring`, async () => {
          const context = await browser.newContext({
            viewport: { width: width.width, height: width.height },
            deviceScaleFactor: width.phone ? 2 : 1,
            hasTouch: width.phone,
            isMobile: width.phone,
            colorScheme: mode,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          const problems: string[] = [];
          tab.on('pageerror', error => problems.push(error.message));
          try {
            await tab.goto(`${origin}/?style=exaggerated&palette=${palette}&mode=${mode}&title=Specimen`);
            await tab.waitForSelector('[data-specimen]');
            await tab.evaluate(async () => await document.fonts.ready);
            // The app shell pins html and body to the viewport (overflow hidden), which would crop a full-page capture to one screen.
            if (shotsDir !== '')
              await tab.addStyleTag({
                content: 'html, body { height: auto !important; overflow: visible !important; }',
              });
            if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
            expect(problems).toEqual([]);
            const report = await tab.evaluate(() => {
              const root = getComputedStyle(document.documentElement);
              const rounded: string[] = [];
              const shadowed: string[] = [];
              for (const element of document.querySelectorAll<HTMLElement>('[data-specimen] *')) {
                const style = getComputedStyle(element);
                const label = `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 60);
                // Drawn = has area beyond a visually hidden 1px box (`sr-only`: a segmented control's radios, which a UA rounds).
                const box = element.getBoundingClientRect();
                const visible = box.width > 1 || box.height > 1;
                // A radio dot, a switch thumb's circle and a status dot are shape signals, never a corner.
                if (visible && style.borderTopLeftRadius !== '0px' && !/dot|spinner/u.test(String(element.className)))
                  rounded.push(`${label} ${style.borderTopLeftRadius}`);
                // A rule drawn INSIDE the box (`inset … 0 Npx 0`, no blur) is a line, not a shadow.
                if (visible && style.boxShadow !== 'none' && !/inset/u.test(style.boxShadow))
                  shadowed.push(`${label} ${style.boxShadow}`);
              }
              const title = document.querySelector<HTMLElement>('[data-part="title"]');
              const titleStyle = title === null ? null : getComputedStyle(title);
              const doc = document.documentElement;
              const card = document.querySelector<HTMLElement>('[data-part="buttons"]');
              const body = card?.querySelector<HTMLElement>('div:not([class*="header"])');
              return {
                overflow: doc.scrollWidth - doc.clientWidth,
                rounded,
                shadowed,
                titleWeight: titleStyle?.fontWeight ?? '',
                titleSize: Number.parseFloat(titleStyle?.fontSize ?? '0'),
                displayWeight: root.getPropertyValue('--weight-display').trim(),
                // The token's text is `calc(3.2rem * var(--fy-text-scale, 1))`, the Text size setting's own wrapper
                // (`text-scale-postcss.ts`), so it is read as the length it resolves to, in rem, at the default scale.
                displaySize: (() => {
                  const probe = document.createElement('i');
                  probe.style.fontSize = 'var(--text-display)';
                  document.body.append(probe);
                  const px = Number.parseFloat(getComputedStyle(probe).fontSize);
                  probe.remove();
                  return `${Math.round((px / Number.parseFloat(getComputedStyle(document.documentElement).fontSize)) * 100) / 100}rem`;
                })(),
                padPanel: root.getPropertyValue('--pad-panel').trim(),
                bodyPadding:
                  body === null || body === undefined ? 0 : Number.parseFloat(getComputedStyle(body).paddingLeft),
              };
            });
            expect(report.overflow).toBeLessThanOrEqual(0);
            expect({ name, rounded: report.rounded }).toEqual({ name, rounded: [] });
            expect({ name, shadowed: report.shadowed }).toEqual({ name, shadowed: [] });
            expect(report.displayWeight).toBe('200');
            // The exaggeration itself: the title is hair-thin and several times the 13px body.
            expect(report.titleWeight).toBe('200');
            // r11 T8: the owner found it too large: the display is capped at 3.25rem (52px) at 1280, so the title is the biggest thing on the page and no more.
            expect(report.titleSize).toBeGreaterThanOrEqual(width.phone ? 40 : 48);
            expect(report.titleSize).toBeLessThanOrEqual(52);
            expect(report.displaySize).toBe(width.phone ? '2.6rem' : '3.2rem');
            expect(report.padPanel).toBe(width.phone ? '18px' : '28px');
            // The keyboard: a field takes a ring of at least 2px.
            await tab.keyboard.press('Tab');
            await tab
              .locator('[data-part="input"]')
              .first()
              .evaluate(element => {
                (element as HTMLElement).focus({ focusVisible: true } as FocusOptions);
              });
            const ring = await tab.evaluate(() => {
              const style = getComputedStyle(document.activeElement as HTMLElement);
              return {
                style: style.outlineStyle,
                width: style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth),
              };
            });
            expect(ring.width).toBeGreaterThanOrEqual(2);
          } finally {
            await context.close();
          }
        });
      }
});
