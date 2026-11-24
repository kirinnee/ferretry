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
 *  - no placeholder syntax (`<field>`) in visible text;
 *  - (gate run 3) the page is viewed from America/Los_Angeles: every time a person sees is on THAT clock with a zone label (PST/PDT), so
 *    no "UTC", no ISO instant, no time without a zone label; no literal backtick; no "Always on" / "Free" strip that is not a control;
 *    no second heading that repeats the shell's title; no value that scrolls inside a clipped box (it wraps); layer cards of one row
 *    are one height.
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
/** The tabs that show a time: each must show at least one, on the viewer's clock with its zone named (the sweep scene feeds each one). */
const TIMED_TABS = [
  'access/devices',
  'accounts/secure-copy',
  'claude-code/claude-code',
  'codex/codex',
  'updates/updates',
  'usage/model-pricing',
  'voice/speedups',
];
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

/** The tabs whose switches and arrows must each say a word you can see. */
const LABELLED_TABS = ['logins/logins', 'runtimes/runtimes'];

/**
 * The only elements allowed a border inside a bordered box, each with its reason. A native form control and a button keep a border:
 * it is the affordance that says "type here" / "press here", and the card around it is a surface, not a second level of the same kind.
 */
const ALLOWED_NESTED = 'input, select, textarea, button, summary, img, svg, hr, [role=switch] *';

/** What a settings page must keep (S1/S2): measured in the page, returned as plain data. */
const measure = (allowed: string) => {
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
  const boxes: string[] = [];
  const wide: string[] = [];
  if (root !== null) {
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el)) continue;
      // ONE border level (g3-set-b): a chip, a pill, a keycap, a segmented tray or a card inside a bordered card or phone mock uses a
      // fill or text weight, never a second border. NOTHING is exempt by where it sits (not "inside a button", not "inline", not a
      // `data-no-nest` opt-out: those hid the chips the gate found); the only elements allowed a border are ALLOWED_NESTED.
      if (boxed(el) && !el.matches(allowed)) {
        boxes.push(describe(el));
        let up: Element | null = el.parentElement;
        while (up !== null && up !== root) {
          if (boxed(up) && visible(up)) {
            nested.push(`${describe(up)}  >  ${describe(el)}`);
            break;
          }
          up = up.parentElement;
        }
        // A mock drawn with absolutely placed parts (a keycap over a phone's text box) has no DOM nesting but is nested all the same:
        // a bordered thing that sits inside the painted rectangle of another bordered thing counts too.
        if (up === root || up === null) {
          const inner = el.getBoundingClientRect();
          for (const other of root.querySelectorAll('*')) {
            if (other === el || other.contains(el) || el.contains(other) || !visible(other) || !boxed(other)) continue;
            const outer = other.getBoundingClientRect();
            if (
              outer.width * outer.height > inner.width * inner.height &&
              inner.left >= outer.left - 1 &&
              inner.right <= outer.right + 1 &&
              inner.top >= outer.top - 1 &&
              inner.bottom <= outer.bottom + 1
            ) {
              nested.push(`${describe(other)}  >(painted inside)  ${describe(el)}`);
              break;
            }
          }
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
  // A segmented control is as wide as its options: where its options keep their own width (they share the track out equally only on a
  // phone or when the caller asks to fill), the track holds no more than a little slack beyond them. The gate saw a ~544px track with
  // two small options bunched at its left.
  const stretched: string[] = [];
  const stacked: string[] = [];
  if (root !== null)
    for (const group of root.querySelectorAll<HTMLElement>('[role=radiogroup][data-neo-segmented]')) {
      if (!visible(group)) continue;
      const options = [...group.querySelectorAll<HTMLElement>(':scope > label')];
      // Two or three options are ONE row of choices (five may wrap to a second line), never a stack that fills the width (the gate's 768/390 layouts scope switch).
      const rects = options.map(option => option.getBoundingClientRect());
      if (
        options.length <= 3 &&
        rects.every((rect, index) => index === 0 || rect.top >= (rects[index - 1]?.bottom ?? 0) - 1)
      )
        stacked.push(`${describe(group)} stacked`);
      if (options.some(option => parseFloat(getComputedStyle(option).flexGrow) > 0)) continue;
      const inner = options.reduce((sum, option) => sum + option.getBoundingClientRect().width, 0);
      const slack = group.getBoundingClientRect().width - inner;
      if (slack > options.length * 4 + 16) stretched.push(`${describe(group)} slack ${Math.round(slack)}px`);
    }
  // A switch, an open-arrow or a menu button carries a word you can SEE, not only a shape and a hidden name (sr-only text and aria
  // labels do not count: they are for a screen reader, and the gate's complaint was about what a person sees).
  const unlabelled: string[] = [];
  if (root !== null)
    for (const control of root.querySelectorAll<HTMLElement>('button, [role=switch]')) {
      if (!visible(control)) continue;
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      let seen = '';
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const holder = node.parentElement;
        if (holder !== null && holder.closest('.sr-only, svg, [aria-hidden=true]') === null)
          seen += node.textContent ?? '';
      }
      seen = seen.trim();
      if (seen === '') unlabelled.push(describe(control));
    }
  // Cards in one row end on one line: their footers (the Remove row) sit at the same bottom edge.
  const footerMisaligned: string[] = [];
  if (root !== null) {
    const cards = [...root.querySelectorAll<HTMLElement>('[data-login-card-wrap]')].filter(visible);
    const rows = new Map<number, HTMLElement[]>();
    for (const card of cards) {
      const top = Math.round(card.getBoundingClientRect().top);
      rows.set(top, [...(rows.get(top) ?? []), card]);
    }
    for (const row of rows.values()) {
      const bottoms = row.flatMap(card => {
        const footer = card.querySelector('[data-login-card-footer]');
        return footer === null ? [] : [Math.round(footer.getBoundingClientRect().bottom)];
      });
      if (bottoms.length > 1 && Math.max(...bottoms) - Math.min(...bottoms) > 1)
        footerMisaligned.push(`footer bottoms ${bottoms.join(' vs ')}`);
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
  const scrolled: string[] = [];
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
    // A value in a box that scrolls sideways inside itself: a person cannot read it (it must wrap).
    for (const el of root.querySelectorAll('code, span, p, dd, a')) {
      if (!visible(el) || el.closest('pre, textarea, svg') !== null) continue;
      const style = getComputedStyle(el);
      if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1)
        scrolled.push(describe(el));
    }
    // Placeholder syntax (`<field> <value>`) shown as if it were a real command.
    for (const match of (root.innerText ?? '').matchAll(/<[A-Za-z][\w -]*>/gu)) placeholders.push(match[0]);
  }
  // Times, words and strings a person must never read (gate run 3): measured on the text as a person reads it.
  const read = (root?.innerText ?? '').replace(/\s+/gu, ' ');
  // A tab that THREW while drawing shows the error boundary's words, not its content: that is a failure, never a pass.
  const crashed =
    /stopped working on this screen/u.test(read) ||
    (root?.querySelector('[role=alert]')?.textContent ?? '').includes('stopped working');
  const utc = [...read.matchAll(/\bUTC\b|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z\b/gu)].map(
    match => read.slice(Math.max(0, match.index - 30), match.index + 24),
  );
  const zoneless = [...read.matchAll(/(?<![\w:.-])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])(?: ?[AP]M)?/gu)]
    .filter(match => !/^ ?(?:PST|PDT)\b/u.test(read.slice(match.index + match[0].length)))
    .map(match => read.slice(Math.max(0, match.index - 30), match.index + match[0].length + 12));
  const zoned = [...read.matchAll(/\b\d{1,2}:\d{2}(?: ?[AP]M)? P[SD]T\b/gu)].length;
  const backticks = [...read.matchAll(/`/gu)].map(match => read.slice(Math.max(0, match.index - 30), match.index + 30));
  const alwaysOn = [...read.matchAll(/\bAlways on\b|\bAlways\b[^.]{0,12}\bfree\b/giu)].map(match => match[0]);
  // Any OTHER visible heading of any level that is the tab's title with only an article added ("The Warden" under "Warden").
  const echoes: string[] = [];
  const shellTitle = (document.querySelector('.fy-settings-title')?.textContent ?? '').trim().toLowerCase();
  if (root !== null && shellTitle !== '')
    for (const el of root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading]')) {
      if (el.matches('.fy-settings-title') || !visible(el)) continue;
      const words = (el.textContent ?? '')
        .trim()
        .toLowerCase()
        .replace(/^(the|your|my) /u, '');
      if (words === shellTitle) echoes.push(describe(el));
    }
  // The cards of one row are one height (a card that is shorter than its neighbour reads as a half-state).
  const uneven: string[] = [];
  const rows = new Map<number, number[]>();
  for (const card of document.querySelectorAll('.fy-wf-layers [data-warden-layer]')) {
    const box = card.getBoundingClientRect();
    rows.set(Math.round(box.top), [...(rows.get(Math.round(box.top)) ?? []), Math.round(box.height)]);
  }
  for (const [top, heights] of rows)
    if (heights.length > 1 && new Set(heights).size > 1) uneven.push(`row at ${top}: ${heights.join('/')}`);
  // What the gate's items need PROVEN present (not merely absent): the code a sentence names, a long key shown whole, the layer cards.
  const codeTexts = root === null ? [] : Array.from(root.querySelectorAll('code'), el => (el.textContent ?? '').trim());
  const wrappedPaths =
    root === null
      ? []
      : Array.from(root.querySelectorAll('[data-wrapped-path]'), el => ({
          text: (el.textContent ?? '').trim(),
          fits: el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth,
        }));
  return {
    full: read.slice(0, 60_000),
    codeTexts,
    wrappedPaths,
    layerCount: document.querySelectorAll('.fy-wf-layers [data-warden-layer]').length,
    crashed,
    zoned,
    utc: utc.slice(0, 6),
    zoneless: zoneless.slice(0, 6),
    backticks: backticks.slice(0, 6),
    alwaysOn: alwaysOn.slice(0, 6),
    echoes: echoes.slice(0, 6),
    uneven,
    scrolled: scrolled.slice(0, 6),
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
    stretched,
    stacked,
    unlabelled: unlabelled.slice(0, 6),
    footerMisaligned,
    boxes: boxes.slice(0, 30),
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
          // The viewer is in Pacific time, as the owner is: every time they see is on this clock, with PST/PDT said.
          timezoneId: 'America/Los_Angeles',
          locale: 'en-US',
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const page = await context.newPage();
        const problems: string[] = [];
        page.on('pageerror', error => problems.push(error.message));
        const logged: string[] = [];
        page.on('console', message => {
          if (message.type() === 'error') logged.push(message.text().slice(0, 300));
        });
        try {
          await page.goto(`${origin}/d/ws/settings/${plugin}/${tab}?theme=studio-${scheme}`);
          await page.waitForSelector('.fy-settings-page', { timeout: 20_000 });
          // The page draws, its reads settle, then it is measured and kept.
          await page.waitForTimeout(1_200);
          const measured = await page.evaluate(measure, ALLOWED_NESTED);
          const requests = await page.evaluate(() => [
            ...new Set((globalThis as { __fyRequests?: string[] }).__fyRequests ?? []),
          ]);
          if (shotsDir !== '')
            await page.screenshot({
              path: join(shotsDir, `${viewport.name}-${scheme}-${plugin}-${tab}.png`),
              fullPage: true,
            });
          // The shell scrolls inside itself, so a page shot cannot reach a long page's lower rows: keep the pricing key's own row.
          if (shotsDir !== '' && plugin === 'usage' && tab === 'model-pricing')
            await page
              .locator('[data-pricing-row]')
              .filter({ hasText: 'anthropic:claude-fake-1' })
              .first()
              .screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${plugin}-${tab}-key.png`) });
          const { full, ...kept } = measured;
          report[`${viewport.name} ${plugin}/${tab}`] = { ...kept, requests, problems, logged };
          expect(measured.sideways, 'scrolls sideways').toBeLessThanOrEqual(0);
          expect(measured.headings, `the visible h1/h2 of ${plugin}/${tab}: exactly one, the tab's title`).toEqual([
            label,
          ]);
          expect(measured.said, `${plugin}/${tab}: the title is said again by`).toEqual([]);
          expect(measured.truncated, 'text cut off with no title to read it').toEqual([]);
          expect(measured.nested, 'a bordered box inside a bordered box').toEqual([]);
          expect(measured.placeholders, 'placeholder syntax in visible text').toEqual([]);
          expect(measured.stretched, 'a segmented control wider than its options').toEqual([]);
          expect(measured.stacked, 'a segmented control drawn as a stack, one option per line').toEqual([]);
          expect(measured.footerMisaligned, 'cards in a row end on different lines').toEqual([]);
          // Logins and Runtimes carry a visible word on every switch, arrow and menu button (g3-set-b item 2).
          if (LABELLED_TABS.includes(`${plugin}/${tab}`))
            expect(measured.unlabelled, 'a control with no visible word').toEqual([]);
          expect(
            measured.crashed,
            `${plugin}/${tab}: the tab crashed while drawing (error boundary shown): ${JSON.stringify(logged)}`,
          ).toBe(false);
          if (TIMED_TABS.includes(`${plugin}/${tab}`))
            expect(
              measured.zoned,
              `${plugin}/${tab}: shows its times on the viewer's clock with PST/PDT said`,
            ).toBeGreaterThan(0);
          if (`${plugin}/${tab}` === 'usage/budgets')
            expect(full, 'the budget zone is said as a short label and the zone').toContain(
              'counted in your zone (PST, America/Los_Angeles)',
            );
          if (`${plugin}/${tab}` === 'access/grants')
            expect(measured.codeTexts, 'the command is drawn as code, not as backticks').toContain(
              'fy daemon config set',
            );
          if (`${plugin}/${tab}` === 'usage/model-pricing') {
            const keys = measured.wrappedPaths.filter(path => path.text.startsWith('anthropic:claude-fake-1'));
            expect(keys.length, 'the long pricing key is on the page').toBeGreaterThan(0);
            expect(
              keys.filter(path => !path.fits),
              'the long pricing key is shown whole (wrapped), never clipped',
            ).toEqual([]);
          }
          if (`${plugin}/${tab}` === 'warden/warden') {
            expect(measured.layerCount, 'the three layer cards').toBe(3);
            expect(full, 'the Warden has no second title of its own').not.toContain('The Warden A supervisor');
          }
          expect(
            measured.utc,
            `${plugin}/${tab}: UTC or an ISO instant a person should see on their own clock`,
          ).toEqual([]);
          expect(measured.zoneless, `${plugin}/${tab}: a time with no zone label`).toEqual([]);
          expect(measured.backticks, `${plugin}/${tab}: a literal backtick in visible text`).toEqual([]);
          expect(measured.alwaysOn, `${plugin}/${tab}: an "Always on / free" statement with no control`).toEqual([]);
          expect(measured.echoes, `${plugin}/${tab}: a heading that says the tab's title again`).toEqual([]);
          expect(measured.uneven, `${plugin}/${tab}: layer cards of one row differ in height`).toEqual([]);
          expect(
            measured.scrolled,
            `${plugin}/${tab}: a value that scrolls inside a clipped box instead of wrapping`,
          ).toEqual([]);
          expect(problems, 'page errors').toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});

/**
 * THE SWEEP'S OWN CHECKS HAVE TEETH: a page that breaks each rule on purpose is measured with the very same function, and it must
 * be caught. (The gate found the earlier asserts too weak: they exempted anything inline, inside a button, or marked `data-no-nest`.)
 */
describe('Settings sweep: the checks catch what they claim to', () => {
  it('flags a chip inside a card, a keycap painted inside a mock, a stretched segmented control and an unlabelled icon button', async () => {
    const context = await browser.newContext({ viewport: { width: 1_280, height: 1_000 }, colorScheme: 'dark' });
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/d/ws/settings/kernel/name?theme=studio-dark`);
      await page.waitForSelector('.fy-settings-page', { timeout: 20_000 });
      await page.evaluate(() => {
        const root = document.querySelector('.fy-settings-page') as HTMLElement;
        const bad = document.createElement('div');
        const line = 'border:1px solid #888;';
        bad.innerHTML = [
          `<div style="${line}padding:8px;position:relative;width:300px;height:80px"><span style="${line}border-radius:999px;padding:1px 8px">chip</span></div>`,
          `<div style="position:relative;width:300px;height:80px"><div style="position:absolute;inset:0;${line}"></div><span style="position:absolute;right:6px;bottom:6px;${line}width:16px;height:14px"></span></div>`,
          `<div role="radiogroup" data-neo-segmented style="display:flex;width:520px"><label style="width:60px">A</label><label style="width:60px">B</label></div>`,
          '<button type="button"><svg width="12" height="12"></svg></button>',
        ].join('');
        root.append(bad);
      });
      const caught = await page.evaluate(measure, ALLOWED_NESTED);
      expect(
        caught.nested.some(line => line.includes('chip')),
        'a chip inside a bordered card',
      ).toBe(true);
      expect(
        caught.nested.some(line => line.includes('painted inside')),
        'a part painted inside a bordered mock',
      ).toBe(true);
      expect(caught.stretched.length, 'a stretched segmented control').toBe(1);
      expect(caught.unlabelled.length, 'an icon button with no word').toBeGreaterThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});

/**
 * THE SETTINGS LIST AT 800px TALL (r10 S14): with every group open the list is longer than the window, so it scrolls inside itself
 * and says so (a thin themed scrollbar and a soft fade at an end that has more), and keyboard focus on its last entry brings that
 * entry into sight instead of clipping it.
 */
describe('Settings list: scrolls and says so at 800px tall', () => {
  for (const viewport of [{ name: '1280x800', width: 1_280, height: 800 }] as const) {
    it(`${viewport.name}: every group open, the list scrolls inside itself with a thin bar, and its last entry is reachable`, async () => {
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
        // The chevrons turn over 120ms: let the opened groups settle so the picture shows chevrons, not a half turn.
        await page.waitForTimeout(400);
        const nav = page.locator('.fy-settings-nav');
        const facts = await nav.evaluate(el => {
          const style = getComputedStyle(el);
          return {
            scrolls: el.scrollHeight > el.clientHeight + 1,
            overflowY: style.overflowY,
            thin: style.scrollbarWidth,
            height: Math.round(el.getBoundingClientRect().height),
          };
        });
        expect(facts.scrolls, `the list (${facts.height}px) is longer than its box`).toBe(true);
        expect(['auto', 'scroll']).toContain(facts.overflowY);
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
        // The focus ring is drawn INSIDE the entry (a negative offset), so the list's own edge cannot clip it, and it is drawn.
        const ring = await page.evaluate(() => {
          const style = getComputedStyle(document.activeElement as Element);
          return {
            offset: parseFloat(style.outlineOffset),
            style: style.outlineStyle,
            width: parseFloat(style.outlineWidth),
          };
        });
        expect(ring.style, 'a visible focus ring').not.toBe('none');
        expect(ring.width).toBeGreaterThan(0);
        expect(ring.offset, 'the ring is inside the entry, not outside where the scroller clips it').toBeLessThan(0);
        // Every group heading shows a real chevron icon (an svg), not a text glyph from a pseudo-element or the browser's triangle.
        const headings = await nav.evaluate(el =>
          [...el.querySelectorAll('summary.fy-tab-group__title')].map(summary => ({
            icon: summary.querySelector('svg.fy-tab-group__chevron') !== null,
            glyph: getComputedStyle(summary, '::after').content,
            marker: getComputedStyle(summary).listStyleType,
          })),
        );
        expect(headings.length).toBeGreaterThan(5);
        for (const heading of headings) {
          expect(heading.icon, 'a chevron icon on the group heading').toBe(true);
          expect(['none', 'normal']).toContain(heading.glyph);
          expect(heading.marker).toBe('none');
        }
        expect(await nav.evaluate(el => el.scrollTop), 'it scrolled to get there').toBeGreaterThan(0);
        if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, 'nav-cue-bottom.png') });
      } finally {
        await context.close();
      }
    });
  }
});
