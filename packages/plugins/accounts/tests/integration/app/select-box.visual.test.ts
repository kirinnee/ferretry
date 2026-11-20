/**
 * ACCOUNTS' LIST CHOICES in a real browser over fake data (`fixtures/select-box-scene.tsx`), r11 S3b: owner words
 * "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear in the
 * middle as a modal ... like a combo box, where people can type to search".
 *
 *   both sizes   the scene draws 0 native `<select>` elements, and its list choices are select boxes (combobox buttons).
 *   1280 (mouse) a click opens a listbox directly under the button; the via list (nine accounts) has a search field;
 *                typing "work" narrows it to the work accounts; Enter picks one; picking "A secret, by name" on the paste
 *                rule form and approving POSTs the same rule the form always wrote, asserted on the fake route.
 *   390 (touch)  a tap opens a dialog CENTRED in the viewport (centre within 8px, both axes), search focused, no page
 *                scroll; the same pick and the same write.
 *
 * Set `FY_ACCOUNTS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ACCOUNTS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
/** What the fake route received, newest last. */
const writes: unknown[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-accounts-select-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/select-box-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the accounts select scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/fake/paste-rules' && request.method === 'POST') {
        writes.push(JSON.parse(await request.text()));
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }
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

interface Variant {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
  readonly scheme: 'light' | 'dark';
}
const VARIANTS: readonly Variant[] = [
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 900, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 900, phone: true, scheme: 'dark' },
];

const open = async (variant: Variant) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}`);
  await tab.waitForSelector('[data-copy-rule-add-open]');
  await tab.click('[data-copy-rule-add-open]');
  await tab.waitForSelector('[data-copy-rule-form]');
  return { tab, problems, close: async () => await context.close() };
};

const hit = async (tab: Page, variant: Variant, selector: string): Promise<void> => {
  if (variant.phone) await tab.tap(selector);
  else await tab.click(selector);
};
const settled = async (tab: Page): Promise<void> => {
  await tab.evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
  });
};
const shotOf = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  await settled(tab);
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};
const box = async (tab: Page, selector: string) =>
  await tab.evaluate(selector => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) return null;
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  }, selector);
const optionLabels = async (tab: Page): Promise<string[]> =>
  await tab.$$eval('[role=option]', options =>
    options.map(option => option.querySelector('[data-label]')?.textContent ?? ''),
  );
const INTO = '[role=combobox][aria-label="Into"]';
const VIA = '[role=combobox][aria-label="Through which account"]';

for (const variant of VARIANTS)
  describe(`Accounts' select boxes (${variant.name})`, () => {
    it('draws no native select, only select boxes', async () => {
      const { tab, problems, close } = await open(variant);
      try {
        const counts = await tab.evaluate(() => ({
          natives: document.querySelectorAll('select').length,
          boxes: [...document.querySelectorAll('[role=combobox]')].map(each => each.getAttribute('aria-label')),
        }));
        expect(counts.natives, 'no native <select> in the accounts scene').toBe(0);
        expect(counts.boxes).toEqual(['From', 'Into', 'How it signs in', 'Through which account']);
        await shotOf(tab, variant, 'closed');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it('opens under the button with a mouse, in the middle of the screen on a phone', async () => {
      const { tab, close } = await open(variant);
      try {
        await hit(tab, variant, INTO);
        if (variant.phone) {
          await tab.waitForSelector('[role=dialog]');
          await settled(tab);
          const dialog = await box(tab, '[role=dialog]');
          const viewport = await tab.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
          expect(dialog).not.toBeNull();
          if (dialog === null) return;
          expect(Math.abs(dialog.left + dialog.width / 2 - viewport.width / 2), 'centred across').toBeLessThanOrEqual(
            8,
          );
          expect(Math.abs(dialog.top + dialog.height / 2 - viewport.height / 2), 'centred down').toBeLessThanOrEqual(8);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        } else {
          await tab.waitForSelector('[role=listbox]');
          await settled(tab);
          const trigger = await box(tab, INTO);
          const list = await box(tab, '[data-select-popover]');
          expect(trigger !== null && list !== null).toBe(true);
          if (trigger === null || list === null) return;
          expect(list.top, 'directly under the button').toBeGreaterThanOrEqual(trigger.bottom - 1);
          expect(list.top - trigger.bottom, 'close to the button').toBeLessThanOrEqual(12);
          expect(list.width).toBeGreaterThanOrEqual(trigger.width - 1);
          expect(await tab.$('[role=dialog]')).toBeNull();
        }
        expect(await optionLabels(tab)).toEqual(['A program in a terminal', 'A field on a page', 'A secret, by name']);
        await shotOf(tab, variant, 'open');
      } finally {
        await close();
      }
    });

    it('searches the accounts: type "work", pick one', async () => {
      const { tab, close } = await open(variant);
      try {
        await hit(tab, variant, VIA);
        await tab.waitForSelector('input[aria-label="Search Through which account"]');
        await settled(tab);
        expect(await tab.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
          'Search Through which account',
        );
        expect((await optionLabels(tab)).length, 'the whole list before typing').toBe(10);
        await tab.keyboard.type('work');
        expect(await optionLabels(tab)).toEqual(['Google (work) · me@work.example.test', 'GitHub (work) · octo-work']);
        await shotOf(tab, variant, 'filtered');
        if (variant.phone) await tab.tap('[role=option]:nth-of-type(1)');
        else await tab.keyboard.press('Enter');
        await tab.waitForSelector('[role=listbox]', { state: 'detached' });
        expect(await tab.textContent('[data-via]')).toBe('ACCOUNT_1');
        expect(await tab.textContent(VIA)).toContain('Google (work)');
      } finally {
        await close();
      }
    });

    it('writes the same rule as before after a pick', async () => {
      const { tab, close } = await open(variant);
      try {
        writes.length = 0;
        await hit(tab, variant, INTO);
        await tab.waitForSelector('[role=option]');
        await hit(tab, variant, '[role=option]:has-text("A secret, by name")');
        await tab.waitForSelector('[role=option]', { state: 'detached' });
        expect(await tab.textContent(INTO)).toContain('A secret, by name');
        await tab.fill('[data-copy-rule-from]', 'gh');
        await tab.fill('[data-copy-rule-to]', 'GH_TOKEN');
        await hit(tab, variant, '[data-copy-rule-form] button[type=submit]');
        await tab.waitForSelector('[data-copy-rule-form]', { state: 'detached' });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
          from: { kind: 'command', program: 'gh' },
          to: { kind: 'secret', name: 'GH_TOKEN' },
        });
      } finally {
        await close();
      }
    });
  });
