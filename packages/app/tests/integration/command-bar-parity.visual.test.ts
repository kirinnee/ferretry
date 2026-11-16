/**
 * THE COMMAND BAR AT v4 PARITY, in a real browser over fake data (`fixtures/command-bar-scene.tsx`): the real bar and the
 * stylesheet that ships, with the entries every plugin contributes. No daemon.
 *
 *  - AT REST: v4's "Go to" list, each place once with its sentence, then the recent ferrets; scrolling inside the bar.
 *  - TYPING "board": the Board first (never Onboarding), with its sentence.
 *  - ON A FERRET'S PAGE: "Board for <ferret>".
 *
 * Set `FY_COMMAND_BAR_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_COMMAND_BAR_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-command-bar-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/command-bar-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the command bar scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

const BAR = '[role="dialog"][aria-label="Command bar"]';

const open = async (variant: (typeof VARIANTS)[number], query = '') => {
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
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  try {
    await tab.waitForSelector(BAR, { timeout: 8_000 });
  } catch (error) {
    throw new Error(`the scene did not draw the bar: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const options = async (tab: Page): Promise<string[]> =>
  await tab
    .locator(`${BAR} [role="option"]`)
    .evaluateAll(nodes => nodes.map(node => (node.querySelector('span.font-semibold')?.textContent ?? '').trim()));

describe('the command bar at v4 parity', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: opens on v4's places, each once with its sentence, then the recent ferrets`, async () => {
      const { tab, close } = await open(variant);
      try {
        await tab.waitForSelector(`${BAR} [role="option"]:has-text("Fixture running")`);
        const labels = await options(tab);
        expect(labels.slice(0, 11)).toEqual([
          'Ferrets',
          'Agenda',
          'Conversations',
          'Board',
          'Projects',
          'Sharing',
          'Subscriptions',
          'Publish skills…',
          'Insights',
          'Warden',
          'Lessons',
        ]);
        expect(new Set(labels).size, 'no place twice').toBe(labels.length);
        expect(labels).toContain('New ferret');
        const text = await tab.locator(`${BAR} [role="listbox"]`).innerText();
        expect(text).toContain('Every task on every machine as lanes');
        expect(text).toContain('Open registered workspaces and folders');
        expect(await tab.locator(`${BAR} .kt-label`).allTextContents()).toEqual(['Go to', 'Ferrets']);
        await shotOf(tab, variant, 'default');
      } finally {
        await close();
      }
    });

    it(`${variant.name}: typing "board" finds the Board first, not Onboarding`, async () => {
      const { tab, close } = await open(variant);
      try {
        await tab.waitForSelector(`${BAR} [role="option"]:has-text("Fixture running")`);
        await tab.locator(`${BAR} input[role="combobox"]`).fill('board');
        const labels = await options(tab);
        expect(labels[0]).toBe('Board');
        expect(labels).not.toContain('Onboarding');
        await shotOf(tab, variant, 'board-search');
      } finally {
        await close();
      }
    });
  }

  it('on a ferret’s page it offers "Board for <ferret>" right after the Board (S-0449)', async () => {
    const { tab, close } = await open(VARIANTS[0], '&ferret=zoe');
    try {
      await tab.waitForSelector(`${BAR} [role="option"]:has-text("Board for Zoe")`);
      const labels = await options(tab);
      expect(labels.indexOf('Board for Zoe')).toBe(labels.indexOf('Board') + 1);
    } finally {
      await close();
    }
  });
});
