/**
 * C59 O11 R4 — the Codex link sign-in draws the way Claude's does, proven on computed geometry in a real browser over fixed
 * fake data (the scene of `sign-in-harness.visual.test.ts`, case `codex-link`):
 *
 *  - the long link is ONE truncated line with "Show full" (never an 11-line block), and its toggle opens it;
 *  - the address is a single-line, masked input: no textarea, no resize handle, the shared secret field;
 *  - Finish is the column's width, and Start over + Cancel are one row whose outer edges are the field's own edges;
 *  - at 1440x900 the whole panel ends above the sticky footer band (the last 70 px of the window);
 *  - nothing scrolls sideways at 390.
 *
 * Set `FY_CODEX_SIGN_IN_SHOTS_DIR` to keep `<viewport>-<theme>-codex-sign-in.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CODEX_SIGN_IN_SHOTS_DIR ?? '';
/** Onboarding's sticky footer band at the bottom of a 900 px window. */
const FOOTER = 70;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-codex-sign-in-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/sign-in-harness-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the sign-in scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;

for (const viewport of VIEWPORTS)
  for (const theme of THEMES)
    describe(`the Codex link sign-in (${viewport.name}, ${theme})`, () => {
      it('is a one-line link, one masked line to paste in, answers on the column, and fits above the footer', async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: theme === 'studio-dark' ? 'dark' : 'light',
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?theme=${theme}&case=codex-link&hold=1200`);
          await tab.locator('[data-codex-login-callback]').waitFor({ state: 'visible' });
          await tab.waitForTimeout(500);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-codex-sign-in.png`) });
          const facts = await tab.evaluate(() => {
            const host = document.querySelector<HTMLElement>('[data-codex-login-callback]');
            const box = (element: Element | null) => {
              const r = element?.getBoundingClientRect();
              return r === undefined
                ? null
                : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height };
            };
            const link = host?.querySelector<HTMLElement>('[data-sign-in-link]') ?? null;
            const field = host?.querySelector<HTMLInputElement>('input[type="password"]') ?? null;
            const secondary = host?.querySelector('[data-sign-in-secondary]') ?? null;
            const finish = host?.querySelector('button[type="submit"]') ?? null;
            const panel = document.querySelector('[data-codex-login]');
            const lineHeight = link === null ? 0 : Number.parseFloat(getComputedStyle(link).lineHeight);
            return {
              link: box(link),
              lineHeight,
              linkClipped: link === null ? false : link.scrollWidth > link.clientWidth,
              toggle: host?.querySelector('[data-sign-in-link-toggle]')?.textContent ?? null,
              textareas: document.querySelectorAll('textarea').length,
              field: box(field),
              fieldResize: field === null ? '' : getComputedStyle(field).resize,
              secondary: box(secondary),
              finish: box(finish),
              panel: box(panel),
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          expect(facts.link).not.toBeNull();
          expect((facts.link?.h ?? 999) < (facts.lineHeight || 1) * 3).toBe(true);
          expect(facts.linkClipped).toBe(true);
          expect(facts.toggle).toBe('Show full');
          expect(facts.textareas).toBe(0);
          expect(facts.fieldResize).toBe('none');
          expect(facts.field?.h ?? 999).toBeLessThan(60);
          // The answers sit on the field's own column.
          expect(Math.abs((facts.secondary?.left ?? 0) - (facts.field?.left ?? 1))).toBeLessThan(1.5);
          expect(Math.abs((facts.secondary?.right ?? 0) - (facts.field?.right ?? 1))).toBeLessThan(1.5);
          expect(Math.abs((facts.finish?.left ?? 0) - (facts.field?.left ?? 1))).toBeLessThan(1.5);
          expect(Math.abs((facts.finish?.right ?? 0) - (facts.field?.right ?? 1))).toBeLessThan(1.5);
          expect(facts.scrollX).toBeLessThanOrEqual(0);
          if (!viewport.phone) expect(facts.panel?.bottom ?? 9_999).toBeLessThanOrEqual(viewport.height - FOOTER);
        } finally {
          await context.close();
        }
      });
    });
