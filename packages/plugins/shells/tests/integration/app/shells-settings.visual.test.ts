/**
 * THE SHELLS SETTINGS TAB in a real browser over fake data: the Remove button lines up on every shell row whatever the
 * build badge says (and nothing wraps awkwardly on a phone), and each Add-form label sits beside its own input.
 *
 * Set `FY_SHELLS_SETTINGS_SHOTS_DIR` to keep `<viewport>-<scheme>-shells.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm as removeTree } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SHELLS_SETTINGS_SHOTS_DIR ?? '';

let browser: Browser;
let built = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), 'ferretry-shells-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', built, '--entry', 'fixtures/shells-settings-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the shells settings scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (built !== '') await removeTree(built, { force: true, recursive: true });
});

/** `panel` is how wide Settings' panel really is at that window (496 at 768, 724 at 1280, the screen at 390). */
const VARIANTS = [
  { name: '1280', width: 1_280, height: 900, panel: 724, phone: false },
  { name: '768', width: 768, height: 900, panel: 496, phone: false },
  { name: '390', width: 390, height: 900, panel: 390, phone: true },
] as const;

describe('The Shells Settings tab', () => {
  for (const variant of VARIANTS)
    for (const scheme of ['dark', 'light'] as const)
      it(`lines Remove up on every row and keeps each label by its input (${variant.name}, ${scheme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          colorScheme: scheme,
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        try {
          await page.goto(`${origin}/?theme=studio-${scheme}&panel=${variant.panel}`);
          await page.waitForSelector('[data-shell="rust-lab"]');
          const rows = await page.evaluate(() =>
            [...document.querySelectorAll('[data-shell]')].map(row => {
              const box = (text: string) => {
                const found = [...row.querySelectorAll('button')].find(button => button.textContent === text);
                const rect = found?.getBoundingClientRect();
                return { left: rect?.left ?? -1, top: rect?.top ?? -1 };
              };
              return { remove: box('Remove'), build: box('Build'), again: box('Resolve again') };
            }),
          );
          expect(rows).toHaveLength(3);
          for (const row of rows) {
            expect(row.remove.left, 'Remove is on the same x on every row').toBeCloseTo(rows[0]?.remove.left ?? 0, 0);
            expect(row.build.left, 'so is Build').toBeCloseTo(rows[0]?.build.left ?? 0, 0);
            expect(row.remove.top, 'the three actions share one line').toBe(row.build.top);
            expect(row.again.top).toBe(row.build.top);
          }
          const fields = await page.evaluate(() =>
            [...document.querySelectorAll('[data-testid="shells-add"] [data-setting-row]')]
              .map(row => {
                const label = row.querySelector('.fy-sh-label span')?.getBoundingClientRect();
                const control = row.querySelector('input, select, [data-select-box]')?.getBoundingClientRect();
                return label === undefined || control === undefined
                  ? undefined
                  : {
                      gapX: control.left - label.right,
                      gapY: control.top - label.bottom,
                      sameLine: control.left > label.right,
                    };
              })
              .filter(field => field !== undefined),
          );
          expect(fields.length).toBeGreaterThanOrEqual(3);
          for (const field of fields) {
            if (field?.sameLine === true)
              expect(field.gapX, 'a label is within a short step of its input').toBeLessThanOrEqual(190);
            else expect(field?.gapY, 'a stacked label is right above its input').toBeLessThanOrEqual(12);
          }
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
          if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-shells.png`) });
        } finally {
          await context.close();
        }
      }, 60_000);

  // r11 S3a: "Made from" is the app's SelectBox, not the browser's select.
  for (const variant of VARIANTS)
    for (const scheme of ['dark', 'light'] as const)
      it(`"Made from" is a SelectBox (no native select; ${variant.phone ? 'a centred dialog' : 'a listbox under it, or a dialog in a narrow panel'}) and picking a flake reveals the flake fields (${variant.name}, ${scheme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          colorScheme: scheme,
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        try {
          await page.goto(`${origin}/?theme=studio-${scheme}&panel=${variant.panel}`);
          await page.waitForSelector('[data-shell="rust-lab"]');
          expect(await page.locator('[data-testid="shells-add"] select').count(), 'no native select').toBe(0);
          const box = page.locator('[role="combobox"][aria-label="Made from"]');
          await box.scrollIntoViewIfNeeded();
          expect((await box.innerText()).trim()).toBe('A package list');
          expect(await page.getByText('Floating', { exact: true }).count()).toBe(0);
          await box.click();
          await page.waitForTimeout(600);
          const open = await page.evaluate(() => {
            const panel = document.querySelector('[role="dialog"], [data-select-popover]') as HTMLElement | null;
            const at = panel?.getBoundingClientRect();
            return at === undefined || panel === null
              ? null
              : {
                  dialog: panel.getAttribute('role') === 'dialog',
                  dx: Math.abs(at.left + at.width / 2 - innerWidth / 2),
                  dy: Math.abs(at.top + at.height / 2 - innerHeight / 2),
                  options: panel.querySelectorAll('[role="option"]').length,
                  inside: at.left >= 0 && at.right <= innerWidth,
                };
          });
          expect(open?.options).toBe(2);
          expect(open?.inside, 'the list is inside the window').toBe(true);
          if (open?.dialog === true) {
            expect(open.dx, 'the dialog is centred across').toBeLessThanOrEqual(8);
            expect(open.dy, 'the dialog is centred down').toBeLessThanOrEqual(8);
          }
          if (variant.phone) expect(open?.dialog, 'a phone gets the dialog').toBe(true);
          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-made-from-open.png`) });
          await page.locator('[role="option"]', { hasText: 'A flake reference' }).click();
          expect((await box.innerText()).trim()).toBe('A flake reference');
          // The same state change a native select made: the row is now a flake reference, with its Floating switch.
          await page.getByText('Flake reference', { exact: true }).first().waitFor();
          expect(await page.getByText('Floating', { exact: true }).count()).toBe(1);
        } finally {
          await context.close();
        }
      }, 60_000);
});
