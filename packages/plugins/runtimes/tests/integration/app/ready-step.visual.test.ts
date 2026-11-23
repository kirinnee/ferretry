/**
 * THE "<TOOL> IS READY" PAGE (O9-6) in a real browser over fake data (`fixtures/ready-step-scene.tsx`): each answer the
 * machine can give about a tool's runtimes (ready, several, none made, cannot start, unreadable) says its words, in both
 * schemes and at phone and desktop width, with no sideways scroll and a footer button of at least 44px.
 *
 * Set `FY_READY_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_READY_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-ready-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/ready-step-scene.tsx'],
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

const CASES = [
  { name: 'ready', query: '', headline: 'Claude Code is ready', kind: 'ready' },
  { name: 'codex-many', query: '&tool=codex&state=many', headline: 'Codex is ready', kind: 'ready' },
  { name: 'none', query: '&tool=codex&state=none', headline: 'No runtime was made for Codex', kind: 'none' },
  {
    name: 'blocked',
    query: '&state=blocked',
    headline: 'Claude Code has a runtime, but it cannot start yet',
    kind: 'blocked',
  },
  { name: 'unread', query: '&state=unread', headline: null, kind: 'unread' },
] as const;

const open = async (variant: Variant, query: string) => {
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
  await tab.waitForSelector('[data-runtime-ready]');
  await tab.waitForTimeout(500);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

for (const variant of VARIANTS)
  describe(`the Ready page, ${variant.name}`, () => {
    for (const each of CASES)
      it(`${each.name}: says its words, no sideways scroll, a 44px footer`, async () => {
        const { tab, problems, close } = await open(variant, each.query);
        try {
          expect(await tab.locator('[data-runtime-ready]').getAttribute('data-runtime-ready')).toBe(each.kind);
          if (each.headline !== null)
            expect((await tab.locator('[data-ready-headline]').innerText()).trim()).toBe(each.headline);
          const facts = await tab.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            buttons: [...document.querySelectorAll<HTMLElement>('[data-step-next], [data-step-back]')].map(button =>
              Math.round(button.getBoundingClientRect().height),
            ),
          }));
          expect(facts.overflow).toBeLessThanOrEqual(0);
          for (const height of facts.buttons) expect(height).toBeGreaterThanOrEqual(44);
          await shot(tab, variant, each.name);
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
  });
