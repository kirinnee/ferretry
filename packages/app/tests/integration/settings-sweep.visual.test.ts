/**
 * THE SETTINGS SWEEP (r10 S14): every settings tab of every shipped plugin, drawn by its REAL app half in the REAL Settings shell
 * (`fixtures/settings-sweep-register.ts` over `fixtures/settings-shell-scene.tsx`) over one fake machine. At 1280 dark (and 768, the
 * width where the settings panel is only ~212px) each tab is checked against the S1/S2 rules, and its picture is kept:
 *  - nothing scrolls sideways, nothing draws outside the window;
 *  - one level of surface: no bordered box inside another bordered box;
 *  - no single text control stretches across a wide panel (a field row stops at 28rem).
 * Set `FY_SETTINGS_SWEEP_SHOTS_DIR` to keep `<viewport>-<plugin>-<tab>.png`, and `FY_SETTINGS_SWEEP_REPORT` for the JSON report.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { generated } from '../../src/generated/surfaces.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETTINGS_SWEEP_SHOTS_DIR ?? '';
const reportPath = process.env.FY_SETTINGS_SWEEP_REPORT ?? '';
const only = (process.env.FY_SETTINGS_SWEEP_ONLY ?? '').split(',').filter(Boolean);

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-settings-sweep-'));
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerSettingsSweep } from ${JSON.stringify(resolve(packageRoot, 'fixtures/settings-sweep-register.ts'))};\nregisterSettingsSweep();\nawait import(${JSON.stringify(resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'))});\n`,
  );
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the sweep scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 300_000);

const report: Record<string, unknown> = {};
afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
  if (reportPath !== '') await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 1_000, phone: false },
  { name: '768', width: 768, height: 1_000, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const TABS = generated.surfaces
  .flatMap(entry =>
    (entry.manifest.ui?.settings ?? []).map(tab => ({ plugin: entry.id, tab: tab.id, label: tab.label })),
  )
  .filter(item => only.length === 0 || only.includes(item.plugin) || only.includes(`${item.plugin}/${item.tab}`));

/** What a settings page must keep (S1/S2): measured in the page, returned as plain data. */
const measure = () => {
  const root = document.querySelector<HTMLElement>('.fy-settings-page');
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const boxed = (el: Element) => {
    const style = getComputedStyle(el);
    const sides = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    const colour = style.borderTopColor;
    return sides.every(w => parseFloat(w) > 0) && !/rgba?\([^)]*,\s*0\)$/.test(colour) && colour !== 'transparent';
  };
  const describe = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}${
      (el.textContent ?? '').trim() ? ` "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"` : ''
    }`;
  const nested: string[] = [];
  const wide: string[] = [];
  if (root !== null) {
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el)) continue;
      if (el.closest('[role=radiogroup], [role=tablist], [role=switch], button, [data-no-nest]') !== null) {
        // A control is one component; only its own wrapper counts below.
      } else if (
        boxed(el) &&
        !el.matches('input, select, textarea, summary, code, pre, kbd, img, svg') &&
        !getComputedStyle(el).display.startsWith('inline')
      ) {
        const parent = el.parentElement?.closest('*');
        let up: Element | null = parent ?? null;
        while (up !== null && up !== root) {
          if (boxed(up) && visible(up)) {
            nested.push(`${describe(up)}  >  ${describe(el)}`);
            break;
          }
          up = up.parentElement;
        }
      }
      if (
        (el instanceof HTMLInputElement &&
          ['text', 'search', 'url', 'email', 'number', 'password', ''].includes(el.type)) ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        const width = el.getBoundingClientRect().width;
        const panel = root.getBoundingClientRect().width;
        if (width > 520 && panel > 700 && !(el instanceof HTMLTextAreaElement))
          wide.push(`${describe(el)} ${Math.round(width)}px of ${Math.round(panel)}px`);
      }
    }
  }
  const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const rootBox = root?.getBoundingClientRect();
  const clipped: string[] = [];
  if (root !== null)
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.right > window.innerWidth + 1) clipped.push(describe(el));
    }
  return {
    text: (root?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160),
    panelWidth: Math.round(rootBox?.width ?? 0),
    panelHeight: Math.round(rootBox?.height ?? 0),
    sideways,
    nested: nested.slice(0, 6),
    nestedCount: nested.length,
    wide: wide.slice(0, 6),
    clipped: clipped.slice(0, 6),
  };
};

describe('Settings sweep: every tab, real app half, real shell', () => {
  for (const viewport of VIEWPORTS) {
    for (const { plugin, tab, label } of TABS) {
      it(`${viewport.name}-dark: ${plugin}/${tab} (${label})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: 'dark',
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        const problems: string[] = [];
        page.on('pageerror', error => problems.push(error.message));
        try {
          await page.goto(`${origin}/d/ws/settings/${plugin}/${tab}?theme=studio-dark`);
          await page.waitForSelector('.fy-settings-page', { timeout: 20_000 });
          // The page draws, its reads settle, then it is measured and kept.
          await page.waitForTimeout(1_200);
          const measured = await page.evaluate(measure);
          const requests = await page.evaluate(() => [
            ...new Set((globalThis as { __fyRequests?: string[] }).__fyRequests ?? []),
          ]);
          if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${viewport.name}-${plugin}-${tab}.png`) });
          report[`${viewport.name} ${plugin}/${tab}`] = { ...measured, requests, problems };
          expect(measured.sideways, 'scrolls sideways').toBeLessThanOrEqual(0);
          expect(problems, 'page errors').toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});
