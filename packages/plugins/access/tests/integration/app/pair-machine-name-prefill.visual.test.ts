/**
 * THE PAIR CONFIRM's "Name this machine" starts with the host of a link that names one, and stays empty (with its hint) for a
 * link by IP address, in a real browser on a phone and a desktop, light and dark, over fake data
 * (`fixtures/pairing-scene.tsx?daemon=<url>`). Set `FY_PAIR_NAME_SHOTS_DIR` to keep `<viewport>-<scheme>-<link>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PAIR_NAME_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pair-name-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pairing-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pairing scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const LINKS = [
  { name: 'named', daemon: 'https://studio.example.com', value: 'studio.example.com' },
  { name: 'ip', daemon: 'http://192.168.1.20:7456', value: '' },
] as const;

describe('the pair confirm machine name', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const link of LINKS)
        it(`${link.name === 'named' ? 'starts with the link host' : 'stays empty for an IP link'} (${viewport.name}, ${scheme})`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            colorScheme: scheme,
            reducedMotion: 'reduce',
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          try {
            await tab.goto(
              `${origin}/?theme=studio-${scheme}&motion=reduced&daemon=${encodeURIComponent(link.daemon)}`,
            );
            await tab.waitForSelector('[data-pair-machine-name]');
            await tab.evaluate(async () => await document.fonts.ready);
            if (shotsDir !== '')
              await tab.screenshot({
                path: join(shotsDir, `${viewport.name}-${scheme}-${link.name}.png`),
                fullPage: true,
              });
            const field = tab.locator('[data-pair-machine-name]');
            expect(await field.inputValue()).toBe(link.value);
            expect(await field.getAttribute('placeholder')).toBe('Optional, e.g. Studio box');
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          } finally {
            await context.close();
          }
        });
});
