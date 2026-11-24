/**
 * THE RUNTIME PICKER IS THREE QUIET READOUTS ON THE COMPOSER'S STATUS LINE, in a real browser (O9-17, after ferret-page-send).
 *
 * The scene (`fixtures/runtime-picker-scene.tsx`) is the REAL picker panel on the status line under the composer's own row
 * classes and the chat page's column, over a fake daemon. At the sweep's windows and a phone, light and dark:
 *
 *  - at rest the bar reads `<model> · <thinking> · <speed>` on ONE line under the row, the box keeps the row, Send is
 *    inside the window; no list and no error, and no model catalog was asked for;
 *  - a tap on any of the three opens ONE popover (a bottom sheet on a phone) wholly inside the window, above that chip, with the model, thinking and
 *    speed lists, the tapped one holding focus;
 *  - with no runtime discovery the popover says so once, quietly (no red alert).
 *
 * Set `FY_RUNTIME_PICKER_SHOTS_DIR` to keep `<window>-<mode>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_RUNTIME_PICKER_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-runtime-picker-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/runtime-picker-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the runtime picker scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const [css, js] = [await readFile(built.css, 'utf8'), await readFile(built.js, 'utf8')];
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const WINDOWS = [
  { name: '1280x713', width: 1_280, height: 713, phone: false },
  { name: '1440x900', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const open = async (size: (typeof WINDOWS)[number], mode: 'light' | 'dark', extra = '') => {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: mode,
    deviceScaleFactor: size.phone ? 2 : 1,
    ...(size.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  await tab.goto(`${origin}/?theme=studio-${mode}${size.phone ? '&compact=1' : ''}${extra}`);
  await tab.waitForSelector('[data-runtime-chip]');
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

const rest = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
    const send = box('[data-composer-send]');
    const form = box('form.fy-composer');
    const field = box('.fy-composer-input-layer');
    const row = box('.fy-composer-row');
    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      sendBottom: send?.bottom ?? NaN,
      sendRight: send?.right ?? NaN,
      formHeight: form?.height ?? NaN,
      fieldWidth: field?.width ?? NaN,
      rowWidth: row?.width ?? NaN,
      chipTops: [...document.querySelectorAll('[data-runtime-chip]')].map(chip =>
        Math.round(chip.getBoundingClientRect().top),
      ),
      chipTexts: [...document.querySelectorAll('[data-runtime-chip]')].map(chip => chip.textContent ?? ''),
      rowBottom: row?.bottom ?? NaN,
      chipsRight: Math.max(
        ...[...document.querySelectorAll('[data-runtime-chip]')].map(chip => chip.getBoundingClientRect().right),
      ),
      menus: document.querySelectorAll('[role="menu"]').length,
      alerts: document.querySelectorAll('[role="alert"]').length,
      asked: (window as unknown as { __asked: string[] }).__asked.slice(),
    };
  });

for (const mode of ['light', 'dark'] as const)
  describe(`the runtime picker in the composer row (${mode})`, () => {
    for (const size of WINDOWS) {
      it(`at ${size.name}: three readouts on one line at rest — the box keeps the row, Send is inside, nothing is asked or said`, async () => {
        const { tab, close } = await open(size, mode, '&discovery=0');
        try {
          await tab.waitForTimeout(300);
          await shot(tab, `${size.name}-${mode}-rest`);
          const seen = await rest(tab);
          expect(seen.formHeight, 'one compact block, not a column taller than the window').toBeLessThan(140);
          expect(seen.sendBottom, 'Send is inside the window').toBeLessThanOrEqual(seen.window.height);
          expect(seen.sendRight, 'Send is inside the window sideways').toBeLessThanOrEqual(seen.window.width);
          expect(seen.fieldWidth, 'the box keeps most of the row').toBeGreaterThanOrEqual(seen.rowWidth * 0.4);
          expect(seen.chipTexts, 'model, thinking, speed').toEqual(['claude-opus-5-5', 'high', 'Normal']);
          expect(new Set(seen.chipTops).size, 'one calm line').toBe(1);
          expect(seen.chipTops[0] ?? 0, 'under the row').toBeGreaterThanOrEqual(seen.rowBottom - 1);
          expect(seen.chipsRight, 'inside the window').toBeLessThanOrEqual(seen.window.width);
          expect(seen.menus, 'no list drawn in the row').toBe(0);
          expect(seen.alerts, 'no error on a composer nobody opened the picker on').toBe(0);
          expect(seen.asked, 'no model catalog asked for').not.toContain('GET /v1/ferrets/:id/runtime-models');
        } finally {
          await close();
        }
      });

      for (const which of ['model', 'effort', 'speed'] as const)
        it(`at ${size.name}: a tap on the ${which} readout opens a popover (a phone: the sheet) wholly inside the window, above it (a phone: docked to the bottom), with all three lists`, async () => {
          const { tab, close } = await open(size, mode);
          try {
            await tab.click(`[data-runtime-chip="${which}"]`);
            await tab.waitForSelector('[data-runtime-popover] [role="menu"]');
            await tab.waitForSelector('[data-runtime-popover] [role="menuitemradio"]');
            await tab.waitForTimeout(size.phone ? 450 : 150);
            await shot(tab, `${size.name}-${mode}-open-${which}`);
            const focused = await tab.evaluate(
              () => document.activeElement?.closest('[data-runtime-list]')?.getAttribute('data-runtime-list') ?? null,
            );
            expect(focused, 'the tapped readout’s list holds focus').toBe(which);
            const box = await tab.evaluate(() => {
              const popover = document.querySelector('[data-runtime-popover]')?.getBoundingClientRect();
              const chip = document.querySelector('[data-runtime-chip][aria-expanded="true"]')?.getBoundingClientRect();
              return {
                window: { width: window.innerWidth, height: window.innerHeight },
                popover: {
                  top: popover?.top ?? NaN,
                  bottom: popover?.bottom ?? NaN,
                  left: popover?.left ?? NaN,
                  right: popover?.right ?? NaN,
                },
                chipTop: chip?.top ?? NaN,
                menus: document.querySelectorAll('[data-runtime-popover] [role="menu"]').length,
              };
            });
            expect(box.popover.top, 'inside the window, top').toBeGreaterThanOrEqual(0);
            expect(box.popover.left, 'inside the window, left').toBeGreaterThanOrEqual(0);
            expect(box.popover.right, 'inside the window, right').toBeLessThanOrEqual(box.window.width);
            if (size.phone)
              expect(box.popover.bottom, 'the sheet is docked to the bottom edge').toBeLessThanOrEqual(
                box.window.height + 1,
              );
            else expect(box.popover.bottom, 'above the chip').toBeLessThanOrEqual(box.chipTop);
            expect(box.menus, 'the model, thinking and speed lists').toBe(3);
            await tab.keyboard.press('Escape');
            await tab.waitForSelector('[data-runtime-popover]', { state: 'detached' });
          } finally {
            await close();
          }
        });
    }

    // KEYBOARD FOCUS (O9-17 review item 4): asserted on document.activeElement, not on a snapshot.
    const focusedIs = async (tab: Page): Promise<string> =>
      await tab.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return 'nothing';
        const chip = active.closest('[data-runtime-chip]')?.getAttribute('data-runtime-chip');
        if (chip) return `chip:${chip}`;
        if (active.hasAttribute('data-runtime-popover')) return 'popover';
        return `other:${active.tagName}`;
      });

    it('returns focus to the chip after Escape', async () => {
      const { tab, close } = await open(WINDOWS[0], mode);
      try {
        await tab.click('[data-runtime-chip="model"]');
        await tab.waitForSelector('[data-runtime-popover] [role="menuitemradio"]');
        expect(await focusedIs(tab), 'focus is inside the list, not on the chip').not.toBe('chip:model');
        await tab.keyboard.press('Escape');
        await tab.waitForSelector('[data-runtime-popover]', { state: 'detached' });
        expect(await focusedIs(tab)).toBe('chip:model');
      } finally {
        await close();
      }
    });

    it('returns focus to the chip after a Fast choice closes the popover', async () => {
      const { tab, close } = await open(WINDOWS[0], mode);
      try {
        await tab.click('[data-runtime-chip="speed"]');
        await tab.waitForSelector('[data-runtime-list="speed"] [role="menuitemradio"]:not([disabled])');
        await tab.keyboard.press('ArrowDown');
        await tab.keyboard.press('Enter');
        await tab.waitForSelector('[data-runtime-popover]', { state: 'detached' });
        expect(await focusedIs(tab)).toBe('chip:speed');
        expect(await tab.textContent('[data-runtime-chip="speed"]')).toBe('Fast');
      } finally {
        await close();
      }
    });

    it('returns focus to the chip after a model choice, which leaves the popover open', async () => {
      const { tab, close } = await open(WINDOWS[0], mode);
      try {
        await tab.click('[data-runtime-chip="model"]');
        await tab.waitForSelector('[data-runtime-list="model"] [role="menuitemradio"]');
        await tab.click('[data-runtime-list="model"] [role="menuitemradio"]:has-text("Sonnet 5.5")');
        await tab.waitForFunction(
          () => document.querySelector('[data-runtime-chip="model"]')?.textContent === 'claude-sonnet-5-5',
        );
        expect(await focusedIs(tab)).toBe('chip:model');
      } finally {
        await close();
      }
    });

    for (const size of WINDOWS)
      it(`at ${size.name}: puts focus on the popover itself when the model has no fast mode, and Escape still returns it to the chip`, async () => {
        const { tab, close } = await open(size, mode, '&model=claude-sonnet-5-5');
        try {
          await tab.click('[data-runtime-chip="speed"]');
          await tab.waitForSelector('[data-runtime-list="speed"]');
          await tab.waitForFunction(() =>
            document.querySelector('[data-runtime-list="speed"]')?.textContent?.includes('no fast mode'),
          );
          await tab.waitForTimeout(150);
          expect(
            await tab.evaluate(
              () => document.querySelectorAll('[data-runtime-list="speed"] [role="menuitemradio"]').length,
            ),
          ).toBe(0);
          expect(await focusedIs(tab)).toBe('popover');
          await shot(tab, `${size.name}-${mode}-no-fast`);
          await tab.keyboard.press('Escape');
          await tab.waitForSelector('[data-runtime-popover]', { state: 'detached' });
          expect(await focusedIs(tab)).toBe('chip:speed');
        } finally {
          await close();
        }
      });

    for (const size of WINDOWS)
      it(`at ${size.name}: with the model list unreadable Fast is drawn disabled with its reason, and Normal stays choosable`, async () => {
        const { tab, close } = await open(size, mode, '&discovery=0');
        try {
          await tab.click('[data-runtime-chip="speed"]');
          await tab.waitForSelector('[data-runtime-list="speed"] [role="menuitemradio"]');
          await tab.waitForTimeout(150);
          await shot(tab, `${size.name}-${mode}-fast-unconfirmed`);
          const items = await tab.evaluate(() =>
            [...document.querySelectorAll<HTMLButtonElement>('[data-runtime-list="speed"] [role="menuitemradio"]')].map(
              item => ({
                text: item.textContent ?? '',
                disabled: item.disabled,
              }),
            ),
          );
          expect(items.find(item => item.text.includes('Fast'))?.disabled, 'Fast is not offered on a guess').toBe(true);
          expect(items.find(item => item.text.includes('Fast'))?.text).toContain('the model list is unavailable');
          expect(items.find(item => item.text.includes('Normal'))?.disabled).toBe(false);
        } finally {
          await close();
        }
      });

    // L226 + L247a + L279 (end-list B4): an UNPINNED ferret (no launch model) the harness reports running Opus. The bar names
    // that model, the model list ticks it, and Fast is offered exactly as chat decides — all from the one observed model.
    for (const size of WINDOWS)
      it(`at ${size.name}: an unpinned ferret the harness reports on Opus names it, ticks it, and offers Fast`, async () => {
        const { tab, close } = await open(size, mode, '&model=none&observed=claude-opus-5-5');
        try {
          const seen = await rest(tab);
          expect(seen.chipTexts, 'the bar names the model in force, never "Default"').toEqual([
            'claude-opus-5-5',
            'high',
            'Normal',
          ]);
          await tab.click('[data-runtime-chip="model"]');
          await tab.waitForSelector('[data-runtime-list="model"] [role="menuitemradio"]');
          await tab.waitForTimeout(450);
          await shot(tab, `${size.name}-${mode}-observed-model`);
          const ticked = await tab.evaluate(() =>
            [...document.querySelectorAll('[data-runtime-list="model"] [role="menuitemradio"]')]
              .filter(item => item.getAttribute('aria-checked') === 'true')
              .map(item => item.textContent ?? ''),
          );
          expect(ticked.length, 'exactly one model is ticked').toBe(1);
          expect(ticked[0], 'the one in force').toContain('Opus 5.5');
          const fast = await tab.evaluate(() => {
            const item = [...document.querySelectorAll<HTMLButtonElement>('[data-runtime-list="speed"] button')].find(
              button => button.textContent?.includes('Fast'),
            );
            return { disabled: item?.disabled, text: item?.textContent ?? '' };
          });
          expect(fast.disabled, `Fast is offered for a model that has it (${fast.text})`).toBe(false);
        } finally {
          await close();
        }
      });

    // L247b: three different reasons Fast is not offered, each in its own sentence.
    for (const [name, extra, sentence] of [
      ['the model is not known', '&model=none', 'the model is not known'],
      ['the model is not in the list', '&model=claude-unlisted-9', 'this model is not in the list'],
      ['the model has no fast mode', '&model=claude-sonnet-5-5', 'has no fast mode'],
    ] as const)
      it(`says why Fast is not offered when ${name}`, async () => {
        const { tab, close } = await open(WINDOWS[0], mode, extra);
        try {
          await tab.click('[data-runtime-chip="speed"]');
          await tab.waitForFunction(
            expected => document.querySelector('[data-runtime-list="speed"]')?.textContent?.includes(expected),
            sentence,
          );
          const text = await tab.evaluate(
            () => document.querySelector('[data-runtime-list="speed"]')?.textContent ?? '',
          );
          expect(text).toContain(sentence);
          for (const other of ['the model is not known', 'this model is not in the list', 'has no fast mode'])
            if (other !== sentence) expect(text, `only its own reason, not "${other}"`).not.toContain(other);
        } finally {
          await close();
        }
      });

    // L260: the model menu shows the friendly name; the raw id is the tooltip only.
    it('shows the model by its name and keeps the raw id as a tooltip only', async () => {
      const { tab, close } = await open(WINDOWS[0], mode);
      try {
        await tab.click('[data-runtime-chip="model"]');
        await tab.waitForSelector('[data-runtime-list="model"] [role="menuitemradio"]');
        const menu = await tab.evaluate(() => {
          const list = document.querySelector('[data-runtime-list="model"]');
          const item = [...(list?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])].find(button =>
            button.textContent?.includes('Opus 5.5'),
          );
          return { text: list?.textContent ?? '', title: item?.title ?? '' };
        });
        expect(menu.text).toContain('Opus 5.5');
        expect(menu.text, 'no raw id drawn in the list').not.toContain('claude-opus-5-5');
        expect(menu.title, 'the id is on demand').toContain('claude-opus-5-5');
      } finally {
        await close();
      }
    });

    // E47b: a phone gets a bottom sheet (v4's shape), a wider window keeps the popover.
    for (const size of WINDOWS)
      it(`at ${size.name}: opens ${size.phone ? 'a bottom sheet' : 'the popover'}, with all three lists`, async () => {
        const { tab, close } = await open(size, mode);
        try {
          await tab.click('[data-runtime-chip="model"]');
          await tab.waitForSelector('[data-runtime-popover] [role="menuitemradio"]');
          await tab.waitForTimeout(400);
          await shot(tab, `${size.name}-${mode}-presentation`);
          const seen = await tab.evaluate(() => {
            const sheet = document.querySelector('[data-bottom-sheet] [role="dialog"]')?.getBoundingClientRect();
            return {
              sheets: document.querySelectorAll('[data-bottom-sheet]').length,
              sheetBottom: sheet?.bottom ?? NaN,
              sheetLeft: sheet?.left ?? NaN,
              sheetRight: sheet?.right ?? NaN,
              windowHeight: window.innerHeight,
              windowWidth: window.innerWidth,
              menus: document.querySelectorAll('[data-runtime-popover] [role="menu"]').length,
              dialogs: document.querySelectorAll('[role="dialog"]').length,
            };
          });
          expect(seen.menus, 'the model, thinking and speed lists').toBe(3);
          expect(seen.dialogs, 'one dialog, not two nested').toBe(1);
          if (size.phone) {
            expect(seen.sheets, 'a bottom sheet').toBe(1);
            expect(Math.abs(seen.sheetBottom - seen.windowHeight), 'docked to the bottom edge').toBeLessThanOrEqual(2);
            expect(seen.sheetLeft, 'inside the window').toBeGreaterThanOrEqual(0);
            expect(seen.sheetRight, 'inside the window').toBeLessThanOrEqual(seen.windowWidth);
          } else expect(seen.sheets, 'no sheet on a wide window').toBe(0);
          await tab.keyboard.press('Escape');
          await tab.waitForSelector('[data-runtime-popover]', { state: 'detached' });
        } finally {
          await close();
        }
      });

    it('with no runtime discovery the popover says so once, quietly — no red alert', async () => {
      const { tab, close } = await open(WINDOWS[0], mode, '&discovery=0');
      try {
        await tab.click('[data-runtime-chip="model"]');
        await tab.waitForSelector('[data-model-choices-unavailable]');
        await shot(tab, `1280x713-${mode}-no-discovery`);
        const said = await tab.evaluate(() => ({
          count: (document.body.textContent?.match(/not connected to Ferrets yet/g) ?? []).length,
          alerts: document.querySelectorAll('[role="alert"]').length,
        }));
        expect(said.count).toBe(1);
        expect(said.alerts).toBe(0);
      } finally {
        await close();
      }
    });
  });
