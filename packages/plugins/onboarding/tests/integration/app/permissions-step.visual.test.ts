/**
 * THE ONBOARDING "PERMISSIONS" STEP in a real browser over fake data (`fixtures/permissions-step-scene.tsx`): ONE tick-box, "Use Ferretry's
 * autonomous defaults (recommended)", ticked by default, covering Claude Code and Codex together; the per-harness Auto / Skip choice sits
 * under "Change"; Next is the only thing that writes. The page counter reads "page 3 of 20" with a bar of 20 segments (the total is
 * the same on every page of a run). No sideways scroll, every target at least 44px tall.
 *
 * Set `FY_PERMISSIONS_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PERMISSIONS_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-permissions-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/permissions-step-scene.tsx'],
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
}, 240_000);

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
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, query = '') => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: variant.scheme,
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
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
  await tab.waitForSelector('[data-permissions-defaults]');
  await tab.waitForTimeout(400);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const writes = (tab: Page) =>
  tab.evaluate(() => (window as unknown as { __writes: { path: string; text: string; etag?: string }[] }).__writes);

for (const variant of VARIANTS)
  describe(`the permissions step, ${variant.name}`, () => {
    it('one ticked tick-box covers both harnesses; Change opens the per-harness choice; nothing is written until Next', async () => {
      const { tab, problems, close } = await open(variant);
      try {
        const tick = tab.locator('[data-permissions-defaults] input');
        expect(await tick.isChecked()).toBe(true);
        const box = await tab.locator('[data-permissions-defaults]').boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(await tab.locator('[data-permissions-defaults]').innerText()).toContain('Claude Code and Codex');
        // The counter: "page 3 of 20", a bar of 20 segments, the third lit.
        expect(await tab.locator('.fy-sp-progress__text').innerText()).toContain('page 3 of 20');
        expect(await tab.locator('.fy-sp-progress__segment').count()).toBe(20);
        expect(await tab.locator('[data-permissions-details]').count()).toBe(0);
        expect(
          await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        ).toBeLessThanOrEqual(0);
        await shot(tab, variant, 'defaults');

        expect((await tab.locator('[data-permissions-change]').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        await tab.locator('[data-permissions-change]').click();
        await tab.waitForSelector('[data-permissions-harness="codex"]');
        expect(await tab.locator('[data-permissions-harness] input[type="radio"]').count()).toBe(4);
        expect(await tab.locator('[data-permissions-harness="claude-code"] input[value="skip"]').isChecked()).toBe(
          true,
        );
        await shot(tab, variant, 'change-open');

        await tab.locator('[data-permissions-harness="codex"] label', { hasText: 'Auto mode' }).click();
        expect(await tick.isChecked()).toBe(false);
        expect(await writes(tab)).toEqual([]);
        await shot(tab, variant, 'codex-auto');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  });

describe('Next writes only permissionMode, once per file that changed', () => {
  it('unticking the box sets Auto mode in both files and nothing else', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      await tab.locator('[data-permissions-defaults] label, [data-permissions-defaults]').first().click();
      await tab.waitForSelector('[data-permissions-details]');
      await tab.locator('[data-step-next]').click();
      await tab.waitForFunction(() => (window as unknown as { __writes: unknown[] }).__writes.length === 2);
      expect(await writes(tab)).toEqual([
        { path: 'harness-claude-code.yaml', text: 'binary: /fake/bin/claude\npermissionMode: auto\n', etag: 'e1' },
        { path: 'harness-codex.yaml', text: 'binary: /fake/bin/codex\npermissionMode: auto\n', etag: 'e1' },
      ]);
    } finally {
      await close();
    }
  });

  it('a file already on Auto starts the box unticked with Change open', async () => {
    const { tab, close } = await open(VARIANTS[0], '&claude=auto');
    try {
      expect(await tab.locator('[data-permissions-defaults] input').isChecked()).toBe(false);
      expect(await tab.locator('[data-permissions-details]').count()).toBe(1);
      await shot(tab, VARIANTS[0], 'claude-auto');
    } finally {
      await close();
    }
  });

  it('only Codex picked: the page covers Codex alone', async () => {
    const { tab, close } = await open(VARIANTS[0], '&only=codex');
    try {
      expect(await tab.locator('[data-permissions-defaults]').innerText()).toContain('Codex run commands');
      expect(await tab.locator('[data-permissions-defaults]').innerText()).not.toContain('Claude Code');
    } finally {
      await close();
    }
  });
});
