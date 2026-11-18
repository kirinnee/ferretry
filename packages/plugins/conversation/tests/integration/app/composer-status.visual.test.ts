/**
 * THE COMPOSER IS ONE CLEAN ROW AND A QUIET STATUS LINE UNDER IT, in a real browser (owner points 6 and 7, 2026-11-17: the
 * composer was "very broken" — `+` and the mic stacked, the model chip under them, `usage unknown` in the corner — and the
 * model, thinking, speed and usage belong "nicely at the bottom, not blocking or eating up space", as in v4).
 *
 * The scene (`fixtures/composer-status-scene.tsx`) is the REAL `Composer` in the chat page's column, its status line
 * holding the model chip and the quota readout. At a desktop and a phone, light and dark, idle and typing:
 *
 *  - ONE ROW holds attach, the text and send (and the mic, when the scene draws Voice's panel), on one line, the text
 *    keeping most of it;
 *  - the status line sits UNDER the row (model chip, usage), never in it, and is a line high, not a block;
 *  - an unknown usage is never drawn as the raw words `usage unknown` (its sentence stays for a screen reader).
 *
 * Set `FY_COMPOSER_STATUS_SHOTS_DIR` to keep `<viewport>-<mode>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_COMPOSER_STATUS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-composer-status-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/composer-status-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the composer status scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const WINDOWS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const open = async (size: (typeof WINDOWS)[number], mode: 'light' | 'dark', usage: 'known' | 'unknown') => {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: mode,
    deviceScaleFactor: 2,
    ...(size.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  await tab.goto(`${origin}/?theme=studio-${mode}&usage=${usage}${size.phone ? '&compact=1' : ''}`);
  await tab.waitForSelector('[data-composer-send]');
  return { tab, close: async () => await context.close() };
};

const FIELD = '.fy-composer-input-layer textarea, .fy-composer-input-layer [contenteditable="true"]';

const layout = async (tab: Page) =>
  await tab.evaluate(() => {
    const rect = (query: string) => document.querySelector(query)?.getBoundingClientRect();
    const attach = rect('[data-composer-attach]');
    const mic = rect('button[aria-label="Dictate"]');
    const field = rect('.fy-composer-input-layer');
    const send = rect('[data-composer-send]');
    const row = rect('.fy-composer-row');
    const model = rect('[data-runtime-chip]');
    const chipLabel = document.querySelector('[data-runtime-chip] > span');
    const quota = document.querySelector('.fy-composer-quota');
    const form = rect('form.fy-composer');
    return {
      attach,
      mic,
      field,
      send,
      row,
      model,
      form,
      rowContainsModel: row !== undefined && model !== undefined && model.top >= row.top && model.bottom <= row.bottom,
      rowContainsQuota: quota !== null && row !== undefined && quota.getBoundingClientRect().top < row.bottom,
      quotaVisibleText: quota === null ? null : (quota.querySelector('[aria-hidden="true"]')?.textContent ?? ''),
      // The chip's whole readout (model, thinking, speed) is on screen, not cut to the model by an ellipsis.
      chipText: chipLabel?.textContent ?? '',
      chipClipped: chipLabel === null ? true : chipLabel.scrollWidth > chipLabel.clientWidth + 1,
      quotaWidth: quota?.getBoundingClientRect().width ?? 0,
      bodyText: document.body.innerText,
    };
  });

for (const mode of ['light', 'dark'] as const)
  describe(`the composer's row and status line (${mode})`, () => {
    for (const size of WINDOWS)
      for (const usage of ['unknown', 'known'] as const)
        it(`at ${size.name}, usage ${usage}: one row of attach, text, send; the status line under it`, async () => {
          const { tab, close } = await open(size, mode, usage);
          try {
            const idle = await layout(tab);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${size.name}-${mode}-${usage}-idle.png`) });

            const { attach, mic, field, send, row, model, form } = idle;
            expect(attach && field && send && row && model && form).toBeTruthy();
            if (!(attach && field && send && row && model && form)) return;

            // ONE ROW: the four controls share a line (their centres within a few px) and sit left to right.
            const centres = [attach, ...(mic ? [mic] : []), field, send].map(box => box.top + box.height / 2);
            expect(Math.max(...centres) - Math.min(...centres), 'attach, text and send share one line').toBeLessThan(
              12,
            );
            if (mic) {
              expect(attach.left).toBeLessThan(mic.left);
              expect(mic.right).toBeLessThanOrEqual(field.left + 1);
            }
            expect(attach.right).toBeLessThanOrEqual(field.left + 1);
            expect(field.right).toBeLessThanOrEqual(send.left + 1);
            // Attach, mic and send are three 44px-ish controls; on a 390 phone the box still keeps a clear third.
            expect(field.width, 'the text keeps most of the row').toBeGreaterThanOrEqual(row.width * 0.4);

            // THE STATUS LINE IS UNDER THE ROW, NEVER IN IT.
            expect(idle.rowContainsModel, 'the model chip is not inside the row').toBe(false);
            expect(model.top, 'the model chip is under the row').toBeGreaterThanOrEqual(row.bottom - 1);
            expect(form.height, 'row plus ONE status line, not a block').toBeLessThan(row.height + 36);

            // E4b: the status line carries model, THINKING and SPEED whenever the session reports them — a fixture ferret
            // that reports none (the relay check's) shows only the model because there is nothing more to say.
            expect(idle.chipText).toBe('claude-opus-5-5 · high · fast');
            expect(idle.chipClipped, 'the chip is not cut to the model alone').toBe(false);

            if (usage === 'unknown') {
              expect(idle.quotaVisibleText ?? '', 'unknown usage is never drawn as raw words').not.toMatch(
                /usage unknown/u,
              );
            } else {
              expect(idle.quotaVisibleText).toMatch(/5h 12%/u);
              expect(idle.quotaVisibleText).toMatch(/wk 38%/u);
            }

            // Typing leaves the row one row and the status line where it was.
            await tab.locator(FIELD).first().click();
            await tab.keyboard.type('Fix the login redirect, then run the tests');
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${size.name}-${mode}-${usage}-typing.png`) });
            const typing = await layout(tab);
            expect(typing.model?.top ?? 0, 'the status line stays under the row while typing').toBeGreaterThanOrEqual(
              (typing.row?.bottom ?? 0) - 1,
            );
          } finally {
            await close();
          }
        });
  });
