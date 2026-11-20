/**
 * THE TWO P0 OWNER LINES, IN A REAL BROWSER over fake data:
 *
 * 1. Turning a machine's tunnel on, when the daemon HOLDS the switch (`202 { held, view }`), says "Waiting for your OK" and
 *    no error — through the real introducer, tunnel store and selector (`fixtures/tunnel-held-wire-scene.tsx`).
 * 2. "Tunnel only" cannot be SAVED while the machine publishes no tunnel (greyed, with the reason), and a device already
 *    stuck on a carrier it cannot reach over sees "Use the default (Relay)", which clears the choice
 *    (`fixtures/carrier-escape-scene.tsx`).
 *
 * Set `FY_P0_TUNNEL_SHOTS_DIR` to keep the pictures (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { TUNNEL_HELD_TITLE, TUNNEL_OFF_SENTENCE } from '../../../contract/index.ts';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_P0_TUNNEL_SHOTS_DIR ?? '';
const SCENES = { held: 'fixtures/tunnel-held-wire-scene.tsx', escape: 'fixtures/carrier-escape-scene.tsx' } as const;

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
const servers: Partial<Record<keyof typeof SCENES, ReturnType<typeof Bun.serve>>> = {};
/** What the fake daemon was asked: every `PUT /v1/tunnel` it held. */
const puts: unknown[] = [];

const off = { enabled: false, explicit: false, state: 'off', tunnelUrl: null, sentence: TUNNEL_OFF_SENTENCE } as const;

async function serve(name: keyof typeof SCENES): Promise<void> {
  const out = join(directory, name);
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', out, '--entry', SCENES[name]], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ${name} scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  servers[name] = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      // The fake machine: its tunnel is off, and turning it on is HELD for the owner (the real daemon's 202).
      if (url.pathname === '/daemon/v1/tunnel') {
        if (request.method === 'PUT') {
          puts.push(await request.json());
          return Response.json({ held: ['the tunnel is turned on'], view: off }, { status: 202 });
        }
        return Response.json(off);
      }
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
}

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-p0-tunnel-'));
  await serve('held');
  await serve('escape');
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 480_000);

afterAll(async () => {
  for (const server of Object.values(servers)) server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;

async function open(
  scene: keyof typeof SCENES,
  query: string,
  viewport: (typeof VIEWPORTS)[number],
  use: (tab: Awaited<ReturnType<Awaited<ReturnType<typeof sharedChromium>>['newPage']>>) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = servers[scene]?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  try {
    await tab.goto(`${origin}/?${query}`);
    await use(tab);
  } finally {
    await context.close();
  }
}

describe('a HELD tunnel switch, through the real introducer', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`shows "${TUNNEL_HELD_TITLE}" and no error (${viewport.name}, ${theme})`, async () => {
        puts.length = 0;
        await open('held', `theme=${theme}`, viewport, async tab => {
          await tab.getByRole('button', { name: 'Turn on' }).click();
          await tab.locator('[data-tunnel-offer="held"]').waitFor({ state: 'visible' });
          expect(await tab.locator('[data-tunnel-held]').innerText()).toBe(TUNNEL_HELD_TITLE);
          // The red line the owner saw: no alert, and not a word of "no status".
          expect(await tab.locator('[role="alert"]').count()).toBe(0);
          expect(await tab.locator('body').innerText()).not.toContain('no status');
          expect(puts).toEqual([{ enabled: true }]);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `held-${viewport.name}-${theme}.png`) });
        });
      });
});

describe('"Tunnel only" while the machine publishes no tunnel', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`is greyed with its reason and is not saved (${viewport.name}, ${theme})`, async () => {
        await open('escape', `scene=select&theme=${theme}`, viewport, async tab => {
          const option = tab.locator('[data-carrier-preference-option="tunnel"]');
          const radio = option.locator('input');
          expect(await radio.isDisabled()).toBe(true);
          expect(await option.getAttribute('data-carrier-preference-refused')).toBe('');
          expect(await option.locator('[data-carrier-preference-note]').innerText()).toBe(
            'This machine has no tunnel yet.',
          );
          // Pressing it (a real click on the card) saves nothing: the choice is still the default, and storage is empty.
          await option.click({ force: true });
          expect(await tab.locator('[data-carrier-preference]').getAttribute('data-carrier-preference')).toBe(
            'default',
          );
          expect(await tab.evaluate(() => localStorage.getItem('fy-carrier-preference-v1'))).toBeNull();
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `refused-${viewport.name}-${theme}.png`) });
          // The other carriers still save.
          await tab.locator('[data-carrier-preference-option="relay"]').click();
          expect(await tab.evaluate(() => localStorage.getItem('fy-carrier-preference-v1'))).toBe('{"d1":"relay"}');
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        });
      });
});

describe('a device stuck on a carrier it cannot reach over', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`is offered "Use the default (Relay)", which clears the choice (${viewport.name}, ${theme})`, async () => {
        await open('escape', `scene=stuck&theme=${theme}`, viewport, async tab => {
          const line = tab.locator('[data-carrier-escape="d1"]');
          await line.waitFor({ state: 'visible' });
          expect(await line.innerText()).toContain('This device can’t reach Studio laptop over “Tunnel only”.');
          const action = tab.getByRole('button', { name: 'Use the default (Relay)' });
          expect((await action.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `escape-${viewport.name}-${theme}.png`) });
          await action.click();
          expect(await tab.locator('[data-carrier-escape]').count()).toBe(0);
          expect(
            await tab.evaluate(
              () =>
                (window as unknown as { __store: { snapshot: () => Record<string, string> } }).__store.snapshot().d1,
            ),
          ).toBeUndefined();
        });
      });
});
