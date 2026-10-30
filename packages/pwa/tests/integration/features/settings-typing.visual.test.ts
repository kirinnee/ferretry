/**
 * TYPING INTO SETTINGS WHILE THE PAGE KEEPS RE-RENDERING, in a real browser (owner: "in settings pages —
 * it keeps refreshing, esp after I typed").
 *
 * The cause was not one surface. The app re-renders Settings on every background session poll and config
 * event, and the machine frame built its panels as arrows that became a new component TYPE on each of
 * those renders — so React unmounted the open panel and the typing went with it. The voice clean-up
 * count saved on every keystroke and disabled itself under the cursor. The scene re-renders its parent
 * every 40 ms with fresh callbacks and records, and real keystrokes go into four fields; each must keep
 * its text, its element and its focus, and a value another device saved must be OFFERED, never forced.
 *
 * It also captures the unlock period's new choices (up to a week, raised with a passkey) at a phone and a
 * desktop, light and dark. Set `FY_SETTINGS_SHOTS_DIR` to keep them; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';
import { boundedContext, overlapped } from '../support/overlap.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_SETTINGS_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

let browser: Browser;
const overlap = overlapped();
const bounded = boundedContext(() => browser, 4);
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-settings-typing-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/settings-typing-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the settings scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

beforeAll(overlap.start);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (phone: boolean, mode: 'light' | 'dark'): Promise<BrowserContext> =>
  await bounded({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });

const open = async (context: BrowserContext, mode: 'light' | 'dark'): Promise<Page> => {
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${mode}`);
  await tab.waitForSelector('[data-security-input="unlockValidityHours"]');
  // The display name sits in the "Manage daemon" disclosure, closed until somebody opens it.
  await tab.locator('[data-daemon-host-checks] summary[aria-label="Manage studio"]').click();
  await tab.waitForSelector('[data-daemon-host-checks] form input');
  return tab;
};

const ticks = async (tab: Page): Promise<number> =>
  await tab.evaluate(() => (window as unknown as { __settingsTyping: { ticks: number } }).__settingsTyping.ticks);

/** Waits until the parent has re-rendered at least `count` more times. */
const rerenders = async (tab: Page, count: number): Promise<void> => {
  const from = await ticks(tab);
  await tab.waitForFunction(
    target => (window as unknown as { __settingsTyping: { ticks: number } }).__settingsTyping.ticks >= target,
    from + count,
  );
};

/** Marks an element, so the same element can be asked for after the re-renders. */
const tag = async (tab: Page, selector: string): Promise<void> => {
  await tab.locator(selector).evaluate(node => node.setAttribute('data-typing-probe', ''));
};

describe('typing into settings while the page re-renders', () => {
  overlap.it(
    'keeps every field’s text, element and focus through dozens of re-renders',
    async () => {
      const context = await newContext(false, 'light');
      try {
        const tab = await open(context, 'light');
        const unlock = '[data-security-input="unlockValidityHours"]';
        const name = '[data-daemon-host-checks] form input';
        const prompt = '#stt-cleanup-prompt-fix';
        const count = '#stt-cleanup-messages';

        await tag(tab, unlock);
        await tab.locator(unlock).fill('');
        await tab.locator(unlock).pressSequentially('72', { delay: 60 });
        await rerenders(tab, 10);
        expect(await tab.locator(unlock).inputValue()).toBe('72');
        expect(await tab.locator(`${unlock}[data-typing-probe]`).count()).toBe(1);
        expect(await tab.evaluate(() => document.activeElement?.getAttribute('data-security-input'))).toBe(
          'unlockValidityHours',
        );
        // Raising it is a passkey away now, not a trip to the machine.
        expect(await tab.locator('[data-security-note-kind="passkey"]').count()).toBe(1);

        await tag(tab, name);
        await tab.locator(name).fill('');
        await tab.locator(name).pressSequentially('studio workstation', { delay: 30 });
        await rerenders(tab, 10);
        expect(await tab.locator(name).inputValue()).toBe('studio workstation');
        expect(await tab.locator(`${name}[data-typing-probe]`).count()).toBe(1);

        await tag(tab, prompt);
        await tab.locator(prompt).fill('');
        await tab.locator(prompt).pressSequentially('Keep my words; fix only the spelling.', { delay: 20 });
        await rerenders(tab, 10);
        expect(await tab.locator(prompt).inputValue()).toBe('Keep my words; fix only the spelling.');
        expect(await tab.locator(`${prompt}[data-typing-probe]`).count()).toBe(1);

        // The count used to save "1" of "10" and disable itself under the cursor.
        await tab.locator(count).fill('');
        await tab.locator(count).pressSequentially('10', { delay: 80 });
        await rerenders(tab, 5);
        expect(await tab.locator(count).inputValue()).toBe('10');
        expect(await tab.locator(count).isDisabled()).toBe(false);
        expect(
          await tab.evaluate(
            () => (window as unknown as { __settingsTyping: { saves: unknown[] } }).__settingsTyping.saves,
          ),
        ).toEqual([]);
        await tab.locator(count).press('Enter');
        expect(
          await tab.evaluate(
            () => (window as unknown as { __settingsTyping: { saves: unknown[] } }).__settingsTyping.saves,
          ),
        ).toEqual([{ conversationMessages: 10 }]);

        // Another device saves a name and a prompt meanwhile: the typing stays, and theirs is offered.
        await tab.evaluate(() =>
          (window as unknown as { __settingsTyping: { moveElsewhere: () => void } }).__settingsTyping.moveElsewhere(),
        );
        await rerenders(tab, 3);
        expect(await tab.locator(name).inputValue()).toBe('studio workstation');
        expect(await tab.locator(prompt).inputValue()).toBe('Keep my words; fix only the spelling.');
        expect(await tab.locator('[data-changed-elsewhere="daemon-label"]').count()).toBe(1);
        expect(await tab.locator('[data-changed-elsewhere="voice-prompt-fix"]').count()).toBe(1);
        await tab.locator('[data-changed-elsewhere-reload="voice-prompt-fix"]').click();
        expect(await tab.locator(prompt).inputValue()).toBe('A prompt another device saved.');
      } finally {
        await context.close();
      }
    },
    60_000,
  );
});

describe('the unlock period, up to a week', () => {
  for (const phone of [false, true])
    for (const mode of ['light', 'dark'] as const)
      overlap.it(
        `offers 1 hour to 7 days and says a passkey is asked for (${phone ? 'phone' : 'desktop'}, ${mode})`,
        async () => {
          const context = await newContext(phone, mode);
          try {
            const tab = await open(context, mode);
            await tab.locator('[data-security-preset="unlockValidityHours:168"]').click();
            expect(await tab.locator('[data-security-input="unlockValidityHours"]').inputValue()).toBe('168');
            expect(await tab.locator('[data-security-bounds="unlockValidityHours"]').innerText()).toBe(
              'Allowed: 1 hour to 7 days.',
            );
            expect(await tab.locator('[data-security-note-kind="passkey"]').innerText()).toContain(
              'Raising this asks for your passkey',
            );
            expect(await tab.locator('[data-security-save="unlockValidityHours"]').isDisabled()).toBe(false);
            // Nothing scrolls sideways, and every choice is a full touch target.
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            for (const box of await tab
              .locator('[data-security-preset]')
              .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)))
              expect(box).toBeGreaterThanOrEqual(44);
            if (shotsDir !== '') {
              const block = tab.locator('[data-security-setting="unlockValidityHours"]');
              await block.scrollIntoViewIfNeeded();
              await block.screenshot({
                path: join(shotsDir, `unlock-period-${phone ? 'phone' : 'desktop'}-${mode}.png`),
              });
            }
          } finally {
            await context.close();
          }
        },
        60_000,
      );
});
