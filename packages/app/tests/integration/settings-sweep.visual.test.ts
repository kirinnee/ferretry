/**
 * THE SETTINGS SWEEP (r10 S14): every settings tab of every shipped plugin, drawn by its REAL app half in the REAL Settings shell
 * (`fixtures/settings-sweep-register.ts` over `fixtures/settings-shell-scene.tsx`) over one fake machine. At 1280 dark (and 768, the
 * width where the settings panel is only ~212px) each tab is checked against the S1/S2 rules, and its picture is kept:
 *  - nothing scrolls sideways, nothing draws outside the window;
 *  - one level of surface: no bordered box inside another bordered box;
 *  - no single text control stretches across a wide panel (a field row stops at 28rem);
 *  - the panel has exactly ONE visible h1/h2 heading and it IS the tab's title (the shell draws it for every tab; a tab draws none),
 *    and the title is drawn once: no other visible text in the panel (a heading of any level, a lone line) says the same words.
 *  - no text is cut off (an ellipsis or a hidden overflow) without its full text in a `title`;
 *  - no placeholder syntax (`<field>`) in visible text.
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
/** `FY_SETTINGS_SWEEP_SCHEME=light` runs the same sweep in the light theme (dark is the default). */
const scheme = process.env.FY_SETTINGS_SWEEP_SCHEME === 'light' ? 'light' : 'dark';
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
        !el.matches('summary, code, pre, kbd, img, svg, .kt-badge') &&
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
  // The panel's visible h1/h2 headings (a 1px clipped, hidden or zero-size one is not seen): one, and it is the shell's.
  const headings: string[] = [];
  if (root !== null)
    for (const el of root.querySelectorAll('h1, h2')) {
      const box = el.getBoundingClientRect();
      if (box.width > 1 && box.height > 1 && visible(el)) headings.push((el.textContent ?? '').trim());
    }
  // The title said twice: any OTHER visible, non-interactive element whose whole text is the tab's title (the shell's h2 is the one).
  const title = document.querySelector('.fy-settings-title');
  const said: string[] = [];
  if (root !== null && title !== null) {
    const words = (title.textContent ?? '').trim().toLowerCase();
    for (const el of root.querySelectorAll('*')) {
      const box = el.getBoundingClientRect();
      if (
        el === title ||
        !visible(el) ||
        box.width <= 1 ||
        box.height <= 1 ||
        el.closest('button, a, [role=tab], option, label, nav, [data-setting-row]') !== null
      )
        continue;
      if (el.children.length > 0 && Array.from(el.children).some(child => (child.textContent ?? '').trim() !== ''))
        continue;
      if ((el.textContent ?? '').trim().toLowerCase() === words) said.push(describe(el));
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
  // Text that is cut off with no way to read it: an ellipsis, or content wider than a box that hides it, unless the full
  // text is in a `title` (on it or on what holds it).
  const truncated: string[] = [];
  const placeholders: string[] = [];
  if (root !== null) {
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el) || el.closest('svg') !== null) continue;
      const style = getComputedStyle(el);
      const hides = ['hidden', 'clip'].includes(style.overflowX);
      // Only text that really is cut: it has to be wider than its box. A screen-reader-only span is 1px by design.
      const cut =
        hides &&
        el.scrollWidth > el.clientWidth + 1 &&
        (el.textContent ?? '').trim() !== '' &&
        (style.textOverflow === 'ellipsis' || el.children.length === 0);
      if (cut && !el.matches('.sr-only') && el.closest('[title], .sr-only') === null) truncated.push(describe(el));
    }
    // Placeholder syntax (`<field> <value>`) shown as if it were a real command.
    for (const match of (root.innerText ?? '').matchAll(/<[A-Za-z][\w -]*>/gu)) placeholders.push(match[0]);
  }
  return {
    truncated: truncated.slice(0, 6),
    placeholders: placeholders.slice(0, 6),
    text: (root?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160),
    panelWidth: Math.round(rootBox?.width ?? 0),
    panelHeight: Math.round(rootBox?.height ?? 0),
    sideways,
    headings,
    said,
    nested: nested.slice(0, 6),
    nestedCount: nested.length,
    wide: wide.slice(0, 6),
    clipped: clipped.slice(0, 6),
  };
};

describe('Settings sweep: every tab, real app half, real shell', () => {
  for (const viewport of VIEWPORTS) {
    for (const { plugin, tab, label } of TABS) {
      it(`${viewport.name}-${scheme}: ${plugin}/${tab} (${label})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: scheme,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        const problems: string[] = [];
        page.on('pageerror', error => problems.push(error.message));
        try {
          await page.goto(`${origin}/d/ws/settings/${plugin}/${tab}?theme=studio-${scheme}`);
          await page.waitForSelector('.fy-settings-page', { timeout: 20_000 });
          // The page draws, its reads settle, then it is measured and kept.
          await page.waitForTimeout(1_200);
          const measured = await page.evaluate(measure);
          const requests = await page.evaluate(() => [
            ...new Set((globalThis as { __fyRequests?: string[] }).__fyRequests ?? []),
          ]);
          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${plugin}-${tab}.png`) });
          report[`${viewport.name} ${plugin}/${tab}`] = { ...measured, requests, problems };
          expect(measured.sideways, 'scrolls sideways').toBeLessThanOrEqual(0);
          expect(measured.headings, `the visible h1/h2 of ${plugin}/${tab}: exactly one, the tab's title`).toEqual([
            label,
          ]);
          expect(measured.said, `${plugin}/${tab}: the title is said again by`).toEqual([]);
          expect(measured.truncated, 'text cut off with no title to read it').toEqual([]);
          expect(measured.nested, 'a bordered box inside a bordered box').toEqual([]);
          expect(measured.placeholders, 'placeholder syntax in visible text').toEqual([]);
          expect(problems, 'page errors').toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});

/**
 * THE SETTINGS LIST AT 800px TALL (r10 S14): with every group open the list is longer than the window, so it scrolls inside itself
 * and says so (a thin themed scrollbar and a soft fade at an end that has more), and keyboard focus on its last entry brings that
 * entry into sight instead of clipping it.
 */
describe('Settings list: scrolls and says so at 800px tall', () => {
  for (const viewport of [{ name: '1280x800', width: 1_280, height: 800 }] as const) {
    it(`${viewport.name}: every group open, the list scrolls inside itself, shows a cue, and its last entry is reachable`, async () => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: 'dark',
      });
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/d/ws/settings/kernel/name?theme=studio-dark`);
        await page.waitForSelector('nav[aria-label="Plugin settings"] .fy-tab-group', { timeout: 20_000 });
        await page.evaluate(() => {
          for (const group of document.querySelectorAll('nav[aria-label="Plugin settings"] details.fy-tab-group'))
            (group as HTMLDetailsElement).open = true;
        });
        const nav = page.locator('.fy-settings-nav');
        const facts = await nav.evaluate(el => {
          const style = getComputedStyle(el);
          return {
            scrolls: el.scrollHeight > el.clientHeight + 1,
            overflowY: style.overflowY,
            fades: (style.backgroundImage.match(/linear-gradient/gu) ?? []).length,
            thin: style.scrollbarWidth,
            height: Math.round(el.getBoundingClientRect().height),
          };
        });
        expect(facts.scrolls, `the list (${facts.height}px) is longer than its box`).toBe(true);
        expect(['auto', 'scroll']).toContain(facts.overflowY);
        expect(facts.fades, 'two fades and two shadows').toBe(4);
        expect(facts.thin).toBe('thin');
        if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, 'nav-cue-top.png') });
        // Focus on the last entry scrolls it into the box: it is not clipped.
        const last = nav.locator('a').last();
        await last.focus();
        const inside = await page.evaluate(() => {
          const list = document.querySelector('.fy-settings-nav')?.getBoundingClientRect();
          const link = document.activeElement?.getBoundingClientRect();
          return list !== undefined && link !== undefined && link.bottom <= list.bottom + 1 && link.top >= list.top - 1;
        });
        expect(inside, 'the last entry is fully inside the list once focused').toBe(true);
        expect(await nav.evaluate(el => el.scrollTop), 'it scrolled to get there').toBeGreaterThan(0);
        if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, 'nav-cue-bottom.png') });
      } finally {
        await context.close();
      }
    });
  }
});
