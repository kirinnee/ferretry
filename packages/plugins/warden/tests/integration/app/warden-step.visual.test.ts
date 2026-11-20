/**
 * THE WARDEN'S FIRST-RUN PAGE in a real browser over fake data (`fixtures/warden-step-scene.tsx`): r11 O7's proof of the
 * owner's line "dont make them go so many places, setup the jev key here!" and of the stacked layout (items 3, 5, 10).
 *
 * The ASSERT, on computed geometry, the DOM and the fake daemon (never a snapshot):
 *   1280 — the three cards share x and width and stack (y increases); the demo sits right of them (> 32 px gap) and its
 *   top is within 8 px of the first card's; choosing "+ Jev" puts a password field on THIS page, with no link into
 *   Settings and none of the old words; a typed key + Save reaches the fake vault route once, and the key's text is then
 *   absent from the DOM, both storages and the console; Next writes `warden.yaml` once (and names the stored key once);
 *   with no key saved Next asks once in the footer and the second Next says yes; the page text is <= 160 characters with
 *   no URL. 390 — no sideways scroll, the three footer buttons are inside the viewport.
 *
 * Set `FY_WARDEN_STEP_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_WARDEN_STEP_SHOTS_DIR ?? '';
const FAKE_KEY = 'jev-fake-key-0123456789abcdef';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-warden-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/warden-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Warden step scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;

type Tab = Awaited<ReturnType<Awaited<ReturnType<typeof sharedChromium>>['newPage']>>;

async function open(
  viewport: (typeof VIEWPORTS)[number],
  theme: string,
  query = '',
): Promise<{ tab: Tab; logs: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const logs: string[] = [];
  tab.on('console', message => logs.push(message.text()));
  tab.on('pageerror', error => logs.push(String(error)));
  await tab.goto(`${origin}/?theme=${theme}${query}`);
  await tab.locator('[data-choice-cards]').waitFor({ state: 'visible' });
  return { tab, logs, close: () => context.close() };
}

const fakeOf = (tab: Tab) => tab.evaluate(() => (window as unknown as { __fake: Record<string, unknown> }).__fake);

describe('the Warden first-run page: layout', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`cards stack, demo on the right, buttons fixed (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme);
        try {
          expect(await tab.locator('[data-choice]').count()).toBe(3);
          await tab.waitForTimeout(1_800);
          const geometry = await tab.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const cards = [...document.querySelectorAll('[data-choice]')].map(el => rect(el));
            const demo = rect(document.querySelector('[data-step-demo]') as Element);
            const buttons = [...document.querySelectorAll('[data-step-footer] button')].map(el => rect(el));
            return {
              cards: cards.map(c => ({ x: c.x, y: c.y, w: c.width, right: c.right })),
              demo: { x: demo.x, y: demo.y, w: demo.width, h: demo.height },
              buttons: buttons.map(b => ({ w: b.width, h: b.height, right: b.right })),
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              viewport: window.innerWidth,
            };
          });
          const { cards, demo, buttons } = geometry;
          for (const card of cards) {
            expect(Math.abs(card.x - (cards[0]?.x ?? 0))).toBeLessThanOrEqual(1);
            expect(Math.abs(card.w - (cards[0]?.w ?? 0))).toBeLessThanOrEqual(1);
          }
          expect((cards[1]?.y ?? 0) > (cards[0]?.y ?? 0)).toBe(true);
          expect((cards[2]?.y ?? 0) > (cards[1]?.y ?? 0)).toBe(true);
          expect(geometry.scrollX).toBeLessThanOrEqual(0);
          for (const button of buttons) expect(button.right).toBeLessThanOrEqual(geometry.viewport);
          if (!viewport.phone) {
            expect(demo.x).toBeGreaterThan((cards[0]?.right ?? 0) + 32);
            expect(Math.abs(demo.y - (cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
            for (const button of buttons) expect(Math.abs(button.w - 136)).toBeLessThanOrEqual(1);
          }
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-rules.png`) });
        } finally {
          await close();
        }
      });
    }
  }
});

describe('the Warden first-run page: the Jev key is set up here', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`pick + Jev, type a key, Save, Next (${viewport.name}, ${theme})`, async () => {
        const { tab, logs, close } = await open(viewport, theme);
        try {
          // Rules only (the default): no key field anywhere.
          expect(await tab.locator('input[type=password]').count()).toBe(0);
          await tab.locator('[data-choice="jev"]').click();
          const field = tab.locator('input[type=password]');
          await field.waitFor({ state: 'visible' });
          await tab.waitForTimeout(1_800);
          // No road into Settings, and none of the old page's words.
          expect(await tab.locator('a[href*="speedups"]').count()).toBe(0);
          const bodyText = await tab.evaluate(() => document.body.innerText);
          for (const old of ['Check again', 'Waiting for the Jev key', 'Settings › Speed-ups', 'Go on without a key'])
            expect(bodyText).not.toContain(old);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-jev-empty.png`) });

          await field.fill(FAKE_KEY);
          await tab.getByRole('button', { name: 'Save' }).click();
          await tab.locator('[data-speedup-set]').waitFor({ state: 'visible' });
          await tab.waitForTimeout(400);
          let fake = (await fakeOf(tab)) as { puts: { name: string; length: number }[]; tests: string[] };
          expect(fake.puts).toEqual([{ name: 'JEV_API_KEY', length: FAKE_KEY.length }]);
          // The key's text is nowhere: not in the DOM, not in either storage, not in the console.
          const where = await tab.evaluate(key => {
            const stores = [localStorage, sessionStorage].map(s => JSON.stringify({ ...s }));
            return {
              html: document.documentElement.outerHTML.includes(key),
              text: document.body.innerText.includes(key),
              stores: stores.some(s => s.includes(key)),
              fields: [...document.querySelectorAll('input,textarea')].some(el =>
                (el as HTMLInputElement).value.includes(key),
              ),
            };
          }, FAKE_KEY);
          expect(where).toEqual({ html: false, text: false, stores: false, fields: false });
          expect(logs.some(line => line.includes(FAKE_KEY))).toBe(false);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-jev-saved.png`) });

          // Test spends one provider call, and it is the person's press.
          await tab.getByRole('button', { name: 'Test the Jev key' }).click();
          await tab.locator('[data-speedup-last-test]').waitFor({ state: 'visible' });
          await tab.waitForTimeout(400);
          fake = (await fakeOf(tab)) as typeof fake;
          expect(fake.tests.length).toBe(1);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-jev-tested.png`) });

          // Next saves: one write of warden.yaml, the stored key named once, then the page moves on.
          await tab.locator('[data-step-next]').click();
          await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
          const after = (await fakeOf(tab)) as {
            writes: { enabled: boolean; jev: boolean; llm: boolean }[];
            names: number;
            done: number;
          };
          expect(after.writes).toEqual([{ enabled: true, jev: true, llm: false }]);
          expect(after.names).toBe(1);
        } finally {
          await close();
        }
      });
    }
  }

  it('the page says little: <= 160 characters beside the key row (<= 60), no URL (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light');
    try {
      await tab.locator('[data-choice="jev"]').click();
      await tab.locator('input[type=password]').waitFor({ state: 'visible' });
      const measured = await tab.evaluate(() => {
        const body = document.querySelector('.wd-step') as HTMLElement;
        const row = body.querySelector('[data-warden-key-row]') as HTMLElement;
        const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
        let text = body.innerText;
        for (const title of [...document.querySelectorAll('.fy-cc__title')].map(el => el.textContent ?? ''))
          text = text.replace(title, '');
        // The key row is Voice's control (label, Save, Test, link): measured on its own.
        return { text: flat(text.replace(row.innerText, '')), row: flat(row.innerText) };
      });
      console.log(
        `warden page text (${measured.text.length} chars): ${measured.text} | key row (${measured.row.length} chars): ${measured.row}`,
      );
      expect(measured.row.length).toBeLessThanOrEqual(60);
      expect(measured.text.length).toBeLessThanOrEqual(160);
      expect(measured.text).not.toMatch(/https?:|www\.|\.com|\.test/);
    } finally {
      await close();
    }
  });

  it('Jev with no key: Next asks once, the second Next goes on (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light');
    try {
      await tab.locator('[data-choice="llm"]').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('Go on without one?');
      expect(((await fakeOf(tab)) as { writes: unknown[] }).writes.length).toBe(0);
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect(((await fakeOf(tab)) as { writes: unknown[] }).writes).toEqual([{ enabled: true, jev: true, llm: true }]);
    } finally {
      await close();
    }
  });

  it('a refused write keeps the page, shows the reason, and Next tries again (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&save=fail');
    try {
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('refused');
      expect(await tab.locator('[data-choice-cards]').isVisible()).toBe(true);
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect(((await fakeOf(tab)) as { writes: unknown[] }).writes.length).toBe(1);
    } finally {
      await close();
    }
  });
});
