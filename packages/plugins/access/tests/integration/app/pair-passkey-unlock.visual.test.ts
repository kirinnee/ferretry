/**
 * S-11, S-68 and S-8 IN A REAL BROWSER, over the pairing scene (`fixtures/pairing-scene.tsx`, fake data, the REAL `StepUpGate` and
 * unlock `StepUpDialog` with `&unlock=1`):
 *
 *  1. RIGHT AFTER "Passkey added" NO SECOND MODAL POPS UP. The unlock is the next step on the same card ("Touch it once more to
 *     unlock this device." and its own button); pressing it unlocks, and the card says so. No `[role=dialog]` is ever drawn.
 *  2. The unlock prompt (a request nobody pressed for, once the card lets go) is content-sized at 390, never the sheet's full width (C-6).
 *  3. The pair confirm and Connected screens hang off ONE left edge at every width: mascot, brand line, heading and field all
 *     start at the column's left edge (the heading used to be centred over start-aligned buttons at 390).
 *
 * Set `FY_PAIR_UNLOCK_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PAIR_UNLOCK_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pair-unlock-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pairing-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pairing scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1440-light', width: 1_440, height: 900, phone: false, scheme: 'light' },
  { name: '1440-dark', width: 1_440, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

const open = async (variant: (typeof VARIANTS)[number], query: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
    reducedMotion: 'reduce',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}&motion=reduced&${query}`);
  return { context, tab };
};

describe('after "Passkey added" the unlock is the next step on the same card (S-11)', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: no second modal; the card says touch once more, Unlock unlocks, the prompt never shows`, async () => {
      const { context, tab } = await open(variant, 'offer=open&unlock=1');
      try {
        await tab.getByRole('button', { name: 'Pair this device' }).click();
        await tab.waitForSelector('[data-first-passkey-add]');
        // Before the passkey: the machine\'s refusal is waiting, and the card holds it, so there is no modal.
        await tab.waitForTimeout(300);
        expect(await tab.locator('[data-step-up-dialog]').count(), 'no modal over the offer').toBe(0);
        await tab.locator('[data-first-passkey-add]').click();
        await tab.waitForSelector('[data-passkey-unlock]');
        expect(await tab.locator('main').innerText()).toContain(
          'Passkey added. Touch it once more to unlock this device.',
        );
        // The moment that used to raise the second modal: leave it long enough for the gate to have shown it.
        await tab.waitForTimeout(600);
        expect(await tab.locator('[data-step-up-dialog]').count(), 'no second modal after Passkey added').toBe(0);
        expect(await tab.locator('[role="dialog"]').count()).toBe(0);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-added-unlock-next.png`) });
        // The next step\'s button is content-sized (C-6), a 44 px target.
        const unlock = (await tab.locator('[data-passkey-unlock]').boundingBox()) ?? { width: 0, height: 0 };
        const column = (await tab.locator('[data-passkey-unlock-next]').boundingBox()) ?? { width: 0 };
        expect(unlock.height).toBeGreaterThanOrEqual(43);
        if (variant.phone) expect(unlock.width, 'not the full width at 390').toBeLessThan(column.width - 40);
        // One primary on the card: Unlock is the way on, "Continue" stands back until it is done.
        expect(
          await tab.locator('[data-paired-continue]').getAttribute('data-variant'),
          'Continue is the quiet answer while Unlock is next',
        ).toBeNull();
        await tab.locator('[data-passkey-unlock]').click();
        await tab.waitForSelector('[data-passkey-unlocked]');
        expect(
          await tab.locator('[data-paired-continue]').getAttribute('data-variant'),
          'Continue is the way on once unlocked',
        ).toBe('primary');
        expect(await tab.locator('main').innerText()).toContain('Passkey added and this device is unlocked.');
        expect(
          await tab.evaluate(
            () => (window as never as { __pairScene: { unlocked: { count: number } } }).__pairScene.unlocked.count,
          ),
        ).toBe(1);
        await tab.waitForTimeout(400);
        expect(
          await tab.locator('[data-step-up-dialog]').count(),
          'the unlock answered the waiting request: no prompt',
        ).toBe(0);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-unlocked.png`) });
      } finally {
        await context.close();
      }
    });
});

describe('the unlock prompt, when it does show, is not full width at 390 (S-68, C-6)', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: Unlock and Cancel are content-sized and start-aligned`, async () => {
      // No card offers a passkey here (no `offer=open`), so the waiting request raises the prompt as it does anywhere else.
      const { context, tab } = await open(variant, 'unlock=1');
      try {
        await tab.getByRole('button', { name: 'Pair this device' }).click();
        await tab.waitForSelector('[data-step-up-confirm]');
        const dialog = (await tab.locator('[data-step-up-dialog]').boundingBox()) ?? { x: 0, width: 0 };
        const confirm = (await tab.locator('[data-step-up-confirm]').boundingBox()) ?? { x: 0, width: 0, height: 0 };
        const cancel = (await tab.getByRole('button', { name: 'Cancel', exact: true }).boundingBox()) ?? {
          x: 0,
          width: 0,
        };
        expect(confirm.height).toBeGreaterThanOrEqual(43);
        if (variant.phone) {
          expect(confirm.width, "Unlock is not the sheet's full width").toBeLessThan(dialog.width - 80);
          expect(Math.abs(cancel.x - confirm.x), 'Cancel starts where Unlock starts').toBeLessThanOrEqual(1);
        }
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-unlock-prompt.png`) });
      } finally {
        await context.close();
      }
    });
});

describe('the pair screens hang off one left edge at every width (S-8)', () => {
  for (const variant of VARIANTS)
    for (const stage of ['confirm', 'connected'] as const)
      it(`${variant.name} ${stage}: the mascot is centred over the column; the heading and the first line start at its left edge`, async () => {
        const { context, tab } = await open(variant, 'offer=open');
        try {
          await tab.waitForSelector('[data-pair-device-rename]');
          if (stage === 'connected') {
            await tab.getByRole('button', { name: 'Pair this device' }).click();
            await tab.waitForSelector('[data-first-passkey-offer]');
          }
          const edges = await tab.evaluate(() => {
            const left = (selector: string): number => {
              const element = document.querySelector(selector) as HTMLElement;
              return element.getBoundingClientRect().left;
            };
            const heading = document.querySelector('#pairing-title') as HTMLElement;
            const range = document.createRange();
            range.selectNodeContents(heading);
            return {
              column: left('.fy-pair-scene main'),
              hero: (() => {
                const box = (document.querySelector('.fy-pair-hero') as HTMLElement).getBoundingClientRect();
                return (box.left + box.right) / 2;
              })(),
              heading: range.getBoundingClientRect().left,
              headingAlign: getComputedStyle(heading).textAlign,
              buttons: (document.querySelector('[data-action-row] .kt-btn') as HTMLElement).getBoundingClientRect()
                .left,
            };
          });
          const padding = await tab.evaluate(() =>
            Number.parseFloat(
              getComputedStyle(document.querySelector('.fy-pair-scene main') as HTMLElement).paddingLeft,
            ),
          );
          const edge = edges.column + padding;
          // &B211: the ferret is centred over the column (its content box), not hung off the column's left edge.
          const columnRight = await tab.evaluate(() => {
            const main = document.querySelector('.fy-pair-scene main') as HTMLElement;
            return main.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(main).paddingRight);
          });
          expect(Math.abs(edges.hero - (edge + columnRight) / 2), 'mascot centred over the column').toBeLessThanOrEqual(
            2,
          );
          expect(Math.abs(edges.heading - edge), 'heading at the left edge').toBeLessThanOrEqual(1);
          expect(['left', 'start']).toContain(edges.headingAlign);
          if (!(variant.phone === false && stage === 'connected'))
            expect(
              Math.abs(edges.buttons - edge) <= 1 || variant.phone === false,
              'buttons at the left edge on a phone',
            ).toBe(true);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${variant.name}-${stage}.png`), fullPage: true });
        } finally {
          await context.close();
        }
      });
});
