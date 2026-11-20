/** A long URL in a Secure copy paste rule wraps at its separators (/ ? & .), never in the middle of a word. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

/** This file's folder: the scene path below is relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SECURE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-secure-url-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/secure-copy-url-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the secure copy scene did not build (${code}):\n${stderr}\n${stdout}`);
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
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '390', width: 390, height: 900 },
  { name: '768', width: 768, height: 900 },
  { name: '1280', width: 1_280, height: 900 },
] as const;
const THEMES = ['studio-dark', 'studio-light'] as const;

describe('a long URL in a paste rule', () => {
  for (const { name, width, height } of VIEWPORTS)
    for (const theme of THEMES)
      it(`wraps only after a URL separator (${name}, ${theme})`, async () => {
        const context = await browser.newContext({
          viewport: { width, height },
          colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        try {
          const tab = await context.newPage();
          await tab.goto(`${origin}/?theme=${theme}`);
          await tab.waitForSelector('[data-copy-route]');
          const report = await tab.evaluate(() => {
            const bad: string[] = [];
            let lines = 0;
            for (const route of document.querySelectorAll('[data-copy-route]')) {
              const walker = document.createTreeWalker(route, NodeFilter.SHOW_TEXT);
              let previous: { char: string; top: number } | null = null;
              let spaced = false;
              for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
                const text = node.textContent ?? '';
                for (let index = 0; index < text.length; index += 1) {
                  const char = text.charAt(index);
                  if (/\s/u.test(char)) {
                    spaced = true;
                    continue;
                  }
                  const range = document.createRange();
                  range.setStart(node, index);
                  range.setEnd(node, index + 1);
                  const top = range.getBoundingClientRect().top;
                  if (previous !== null && top > previous.top + 4) {
                    lines += 1;
                    if (!spaced && !'/?&.-→'.includes(previous.char))
                      bad.push(`${previous.char}|${char} in "${route.textContent ?? ''}"`);
                  }
                  previous = { char, top };
                  spaced = false;
                }
              }
            }
            const card = document.querySelector('.fy-sc')?.getBoundingClientRect();
            return { bad, lines, cardRight: card?.right ?? 0, viewport: document.documentElement.clientWidth };
          });
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${theme}-secure-copy-url.png`) });
          expect(report.bad, 'every line break is at a URL separator or a space').toEqual([]);
          expect(report.cardRight, 'the card stays inside the screen').toBeLessThanOrEqual(report.viewport);
          if (name === '390') expect(report.lines, 'the phone really wraps the long URLs').toBeGreaterThan(0);
        } finally {
          await context.close();
        }
      }, 120_000);
});
