/**
 * AN UNREADABLE QUESTION FORM, in a real browser: when the daemon could not read the form's selected row it types nothing
 * and says so in a sentence, with the Console as the way on. The scene (`fixtures/question-unreadable-scene.tsx`) is the
 * real `QuestionForm` over fixed fake data. Set `FY_QUESTION_UNREADABLE_SHOTS_DIR` to keep it at a phone and a desktop,
 * light and dark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_QUESTION_UNREADABLE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-question-unreadable-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/question-unreadable-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the question scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

describe('a question form the daemon could not read safely', () => {
  for (const { name, viewport, deviceScaleFactor } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`says what happened and where to answer on a ${name} in ${scheme}`, async () => {
        const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor });
        try {
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab.locator('input').first().check();
          await tab.locator('.fy-question-submit').click();
          const alert = tab.locator('[role="alert"]');
          await alert.waitFor();
          expect(await alert.innerText()).toBe(
            "Couldn't read this question's form safely, so nothing was sent. Answer it at the terminal (the Console tab).",
          );
          expect(await tab.locator('.fy-question-console').count()).toBe(1);
          if (shotsDir !== '') {
            await tab.waitForTimeout(150);
            await tab.screenshot({ path: join(shotsDir, `unreadable-${name}-${scheme}.png`) });
          }
        } finally {
          await context.close();
        }
      }, 60_000);
});
