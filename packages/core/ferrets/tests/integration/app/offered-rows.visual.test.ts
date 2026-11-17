/**
 * THE ACTIONS MENU'S OFFERED ROWS, in a real browser over fake data (`fixtures/offered-rows-scene.tsx`): each row another
 * plugin offers is drawn with an icon of its own, and a row the menu does not know keeps the generic one.
 *
 * Set `FY_W8_SHOTS_DIR` to keep `<viewport>-<theme>-offered-rows.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_W8_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-offered-rows-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/offered-rows-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the offered-rows scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 640, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 640, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 760, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 760, phone: true, scheme: 'dark' },
] as const;

describe('the Actions menu', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: every offered row has an icon of its own; an unknown row keeps the generic one`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        deviceScaleFactor: variant.phone ? 2 : 1,
        hasTouch: variant.phone,
        isMobile: variant.phone,
        colorScheme: variant.scheme,
      });
      const tab = await context.newPage();
      tab.setDefaultTimeout(8_000);
      try {
        await tab.goto(
          `${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}${variant.phone ? '&compact=1' : ''}`,
        );
        await tab.click('[data-ferret-actions-trigger]');
        await tab.waitForSelector('[data-ferret-actions-menu]');
        const icons = await tab.evaluate(() =>
          Object.fromEntries(
            [...document.querySelectorAll('[data-ferret-action-item]')].map(item => [
              item.getAttribute('data-ferret-action-item'),
              [...(item.querySelector('svg')?.classList ?? [])].find(
                name => name.startsWith('lucide-') && name !== 'lucide',
              ) ?? '',
            ]),
          ),
        );
        const known = Object.entries(icons).filter(([id]) => id !== 'something-new');
        expect(known).toHaveLength(7);
        expect(new Set(known.map(([, icon]) => icon)).size, 'one icon per known row').toBe(7);
        for (const [id, icon] of known) expect(icon, id).not.toBe(icons['something-new']);
        expect(icons['something-new']).toContain('puzzle');
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-offered-rows.png`) });
      } finally {
        await context.close();
      }
    });
});
