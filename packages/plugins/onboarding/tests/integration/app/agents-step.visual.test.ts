/**
 * THE "WHICH AI DO YOU WANT TO USE?" STEP (C59 O8-15) in a real browser over fake data (`fixtures/agents-step-scene.tsx`): Claude is
 * the first row and ticked, Gemini is shown and cannot be ticked, Others opens the providers the (fake) catalog lists and a ticked
 * provider asks which harness runs it, with no sideways scroll and every row at least 44px tall to touch.
 *
 * Set `FY_AGENTS_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENTS_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-agents-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agents-step-scene.tsx'],
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
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant) => {
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
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}`);
  await tab.waitForSelector('[data-agent-row="claude"]');
  await tab.waitForTimeout(400);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const measure = async (tab: Page) =>
  await tab.evaluate(() => ({
    rows: [...document.querySelectorAll<HTMLElement>('[data-agent-row] > label')].map(label => ({
      row: label.parentElement?.getAttribute('data-agent-row') ?? '',
      height: Math.round(label.getBoundingClientRect().height),
      checked: label.querySelector('input')?.checked ?? false,
      disabled: label.querySelector('input')?.disabled ?? false,
    })),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

for (const variant of VARIANTS)
  describe(`the picker, ${variant.name}`, () => {
    it('lists Claude first and ticked, Gemini disabled, with no sideways scroll; Others opens the catalog and asks the harness', async () => {
      const { tab, problems, close } = await open(variant);
      try {
        const before = await measure(tab);
        expect(before.rows.map(row => row.row)).toEqual(['claude', 'codex', 'gemini', 'others']);
        expect(before.rows.find(row => row.row === 'claude')?.checked).toBe(true);
        expect(before.rows.find(row => row.row === 'gemini')?.disabled).toBe(true);
        expect(before.overflow).toBeLessThanOrEqual(0);
        for (const row of before.rows) expect(row.height, `${row.row} is a 44px target`).toBeGreaterThanOrEqual(44);
        await shot(tab, variant, 'picker');

        await tab.locator('[data-agent-row="others"] > label').click();
        await tab.waitForSelector('[data-agent-row="provider-kimi"]');
        await tab.locator('[data-agent-row="provider-glm"] > label').click();
        await tab.waitForSelector('[data-agent-harness="glm"]');
        await tab.waitForTimeout(200);
        const opened = await measure(tab);
        expect(opened.rows.map(row => row.row).slice(3)).toEqual([
          'others',
          'provider-kimi',
          'provider-glm',
          'provider-deepseek',
          'provider-minimax',
          'provider-ollama',
          'provider-groq',
          'provider-cerebras',
          'provider-mistral',
        ]);
        expect(opened.overflow).toBeLessThanOrEqual(0);
        await shot(tab, variant, 'others-harness');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  });

describe('the fixture reads as the page does', () => {
  it('has the harness question only under a ticked provider', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      await tab.locator('[data-agent-row="others"] > label').click();
      await tab.waitForSelector('[data-agent-row="provider-kimi"]');
      expect(await tab.locator('[data-agent-harness]').count()).toBe(0);
      await tab.locator('[data-agent-row="provider-kimi"] > label').click();
      expect(await tab.locator('[data-agent-harness]').count()).toBe(1);
    } finally {
      await close();
    }
  });
});
