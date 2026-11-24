/**
 * SELECT BOX and DIALOG in a real browser over fake data (`fixtures/select-box-scene.tsx`): the owner's line
 * "for dropdown, please use a custom component instead of the browser's default ... on mobile, make it appear in the
 * middle as a modal ... like a combo box, where people can type to search".
 *
 *   1280 (mouse)  click opens a listbox under the button (flipped above it at the foot of the window); typing narrows
 *                 it (accent- and case-insensitive, hints too); arrows + Enter pick ONCE; Esc closes and the focus
 *                 returns; a disabled option is neither reached nor picked.
 *   390 (touch)   a tap opens a CENTRED dialog (centre within 8px of the viewport's, both axes), search focused, the
 *                 page behind inert and unscrolled, the list scrolling inside it, a scroll bar only when needed.
 *   Dialog        height by content, ONE scroll container, a scroll bar only when the content overflows, never a
 *                 horizontal one; Esc, focus trap, focus back.
 *   Container     a 500px component container (CSS `container-type`) inside a 1280px window gets the dialog too: the width
 *                 that decides is the container's, alongside a coarse pointer.
 *   ARIA          the structure a screen reader needs, asserted from the DOM, and axe-core (a pinned dev dependency) run
 *                 on the open scenes, light and dark, desktop and phone, with the empty-filter state included.
 *
 * Set `FY_SELECT_BOX_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const axeSource = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const shotsDir = process.env.FY_SELECT_BOX_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-select-box-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/select-box-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the select box scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
  readonly scheme: 'light' | 'dark';
}
const DESKTOP: Viewport = { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' };
const DESKTOP_DARK: Viewport = { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' };
const PHONE: Viewport = { name: '390-light', width: 390, height: 800, phone: true, scheme: 'light' };
const PHONE_DARK: Viewport = { name: '390-dark', width: 390, height: 800, phone: true, scheme: 'dark' };
/** A narrow window with a MOUSE: the dialog is chosen by width alone. */
const NARROW: Viewport = { name: '500-light', width: 500, height: 800, phone: false, scheme: 'light' };

const open = async (variant: Viewport, query: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector('#agent-default, [data-open]');
  return { tab, problems, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: Viewport, name: string): Promise<void> => {
  // A shot of a half-faded dialog or a half-turned chevron judges nothing: let every animation finish first.
  await tab.evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
  });
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const press = async (tab: Page, variant: Viewport): Promise<void> => {
  if (variant.phone) await tab.tap('#agent-default');
  else await tab.click('#agent-default');
};

const hit = async (tab: Page, variant: Viewport, selector: string): Promise<void> => {
  if (variant.phone) await tab.tap(selector);
  else await tab.click(selector);
};

const box = async (tab: Page, selector: string) =>
  await tab.evaluate(selector => {
    const element = document.querySelector<HTMLElement>(selector);
    if (element === null) return null;
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  }, selector);

const picks = async (tab: Page): Promise<string[]> => await tab.evaluate(() => window.__picks.slice());
const optionLabels = async (tab: Page): Promise<string[]> =>
  await tab.$$eval('[role=option]', options =>
    options.map(option => option.querySelector('[data-label]')?.textContent ?? ''),
  );
const focusedId = async (tab: Page): Promise<string> => await tab.evaluate(() => document.activeElement?.id ?? '');

interface AxeResult {
  readonly violations: readonly {
    readonly id: string;
    readonly nodes: readonly { readonly target: unknown; readonly any: readonly { readonly message: string }[] }[];
  }[];
}
declare global {
  interface Window {
    axe: { run: (context: Document, options: object) => Promise<AxeResult> };
  }
}
/** Page-level rules a three-line fixture page cannot satisfy and a component cannot own; every component rule stays on. */
const PAGE_RULES = ['region', 'document-title', 'html-has-lang', 'landmark-one-main', 'page-has-heading-one'];
/** axe-core over the page as it is now: a list of `rule: message @ target` lines, empty when clean. */
const axeViolations = async (tab: Page): Promise<string[]> => {
  if (!(await tab.evaluate(() => typeof window.axe !== 'undefined'))) await tab.addScriptTag({ content: axeSource });
  const result = await tab.evaluate(
    async rules =>
      await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
        rules: Object.fromEntries(rules.map(id => [id, { enabled: false }])),
      }),
    PAGE_RULES,
  );
  return result.violations.flatMap(violation =>
    violation.nodes.map(node => `${violation.id}: ${node.any[0]?.message ?? ''} @ ${JSON.stringify(node.target)}`),
  );
};
/** Every `aria-controls` on the page names an element that exists. */
const dangling = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    [...document.querySelectorAll('[aria-controls]')].flatMap(element =>
      (element.getAttribute('aria-controls') ?? '')
        .split(/\s+/)
        .filter(id => id !== '' && document.getElementById(id) === null),
    ),
  );

declare global {
  interface Window {
    __picks: string[];
  }
}

for (const variant of [DESKTOP, DESKTOP_DARK]) {
  describe(`SelectBox with a mouse (${variant.name})`, () => {
    it('should open a listbox directly under the button, as wide as the button at least', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        await shotOf(tab, variant, 'closed');
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        await shotOf(tab, variant, 'open');
        const trigger = await box(tab, '#agent-default');
        const list = await box(tab, '[data-select-popover]');
        expect(trigger).not.toBeNull();
        expect(list).not.toBeNull();
        if (trigger === null || list === null) return;
        expect(list.top).toBeGreaterThanOrEqual(trigger.bottom);
        expect(list.top - trigger.bottom).toBeLessThanOrEqual(12);
        expect(Math.abs(list.left - trigger.left)).toBeLessThanOrEqual(1);
        expect(list.width).toBeGreaterThanOrEqual(trigger.width - 1);
        expect(list.right).toBeLessThanOrEqual(variant.width);
      } finally {
        await close();
      }
    });

    it('should narrow on typing "aut" to the matching options, then pick the arrowed one ONCE and give the focus back', async () => {
      const { tab, problems, close } = await open(variant, '&n=8');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        await tab.keyboard.type('aut');
        expect(await optionLabels(tab)).toEqual(['Automatic', 'Auto-approve edits']);
        await shotOf(tab, variant, 'filtered');
        await tab.keyboard.press('ArrowDown');
        await tab.keyboard.press('Enter');
        expect(await picks(tab)).toEqual(['auto-approve']);
        expect(await tab.$('[role=listbox]')).toBeNull();
        expect(await focusedId(tab)).toBe('agent-default');
        expect(await tab.textContent('#agent-default')).toContain('Auto-approve edits');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it('should close on Escape with no pick and the focus back on the button', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        await tab.keyboard.press('Escape');
        expect(await tab.$('[role=listbox]')).toBeNull();
        expect(await picks(tab)).toEqual([]);
        expect(await focusedId(tab)).toBe('agent-default');
      } finally {
        await close();
      }
    });

    it('should match without accents or case, and match the hint as well as the label', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        await press(tab, variant);
        await tab.keyboard.type('CAFE');
        expect(await optionLabels(tab)).toEqual(['Café mode']);
        await tab.keyboard.press('Control+A');
        await tab.keyboard.type('never writes');
        expect(await optionLabels(tab)).toEqual(['Plan only']);
        await tab.keyboard.press('Control+A');
        await tab.keyboard.type('zzz');
        expect(await optionLabels(tab)).toEqual([]);
        expect(await tab.textContent('[data-select-empty]')).toContain('zzz');
      } finally {
        await close();
      }
    });

    it('should skip a disabled option with the arrows and refuse its click', async () => {
      const { tab, close } = await open(variant, '&n=8&searchable=never');
      try {
        await press(tab, variant);
        // Automatic is chosen; down x3 walks Auto-approve, Ask, Plan; the next one is "Read only" (disabled): the cursor skips it.
        for (let step = 0; step < 4; step += 1) await tab.keyboard.press('ArrowDown');
        const active = await tab.$eval('[role=option][data-active=true] [data-label]', element => element.textContent);
        expect(active).toBe('Café mode');
        await tab.click('[role=option][aria-disabled=true]', { force: true });
        expect(await picks(tab)).toEqual([]);
        expect(await tab.$('[role=listbox]')).not.toBeNull();
      } finally {
        await close();
      }
    });

    it('should have no search box for 5 options and pick with the arrows and Enter alone', async () => {
      const { tab, close } = await open(variant, '&n=5');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        expect(await tab.$('[data-select-popover] input')).toBeNull();
        await tab.keyboard.press('ArrowDown');
        await tab.keyboard.press('Enter');
        expect(await picks(tab)).toEqual(['auto-approve']);
      } finally {
        await close();
      }
    });

    it('should keep a 2-option list WITHOUT a search box in the popover (the threshold still decides on a desktop)', async () => {
      const { tab, close } = await open(variant, '&n=2');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        expect(await tab.$('[data-select-popover] input')).toBeNull();
        expect(await tab.$('[role=dialog]')).toBeNull();
        await shotOf(tab, variant, 'popover-two');
      } finally {
        await close();
      }
    });

    it('should search 60 options, scroll the list inside the popover and leave the page where it was', async () => {
      const { tab, close } = await open(variant, '&n=60');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        expect(await tab.$('[data-select-popover] input')).not.toBeNull();
        const measure = await tab.evaluate(() => {
          const list = document.querySelector<HTMLElement>('[role=listbox]');
          const pop = document.querySelector<HTMLElement>('[data-select-popover]');
          if (list === null || pop === null) return null;
          return {
            overflows: list.scrollHeight > list.clientHeight,
            popBottom: pop.getBoundingClientRect().bottom,
            popHeight: pop.getBoundingClientRect().height,
          };
        });
        expect(measure?.overflows).toBe(true);
        expect(measure?.popBottom ?? 9_999).toBeLessThanOrEqual(variant.height);
        expect(measure?.popHeight ?? 9_999).toBeLessThanOrEqual(340);
        await tab.mouse.move(variant.width / 2 - 300, 300);
        await tab.keyboard.press('End');
        expect(await tab.evaluate(() => document.querySelector('[role=listbox]')?.scrollTop ?? 0)).toBeGreaterThan(0);
        expect(await tab.evaluate(() => window.scrollY)).toBe(0);
      } finally {
        await close();
      }
    });

    it('should flip ABOVE the button at the foot of the window and stay inside it', async () => {
      const { tab, close } = await open(variant, '&n=12&edge=bottom');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        const trigger = await box(tab, '#agent-default');
        const list = await box(tab, '[data-select-popover]');
        if (trigger === null || list === null) throw new Error('no boxes');
        expect(list.bottom).toBeLessThanOrEqual(trigger.top);
        expect(list.top).toBeGreaterThanOrEqual(0);
        await tab.keyboard.type('s');
        const after = await box(tab, '[data-select-popover]');
        expect(after?.bottom ?? 0).toBeLessThanOrEqual(trigger.top);
        expect(trigger.top - (after?.bottom ?? 0)).toBeLessThanOrEqual(12);
      } finally {
        await close();
      }
    });

    it('should close on a click outside, and on Tab, without a pick', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        await tab.mouse.click(variant.width - 20, variant.height - 20);
        expect(await tab.$('[role=listbox]')).toBeNull();
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        await tab.keyboard.press('Tab');
        expect(await tab.$('[role=listbox]')).toBeNull();
        expect(await picks(tab)).toEqual([]);
      } finally {
        await close();
      }
    });

    it('should expose the combobox and listbox structure a screen reader needs', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        const closed = await tab.$eval('#agent-default', element => ({
          role: element.getAttribute('role'),
          popup: element.getAttribute('aria-haspopup'),
          expanded: element.getAttribute('aria-expanded'),
          name: element.getAttribute('aria-label'),
          labelFor: document.querySelector('label[for=agent-default]')?.textContent,
        }));
        expect(closed).toEqual({
          role: 'combobox',
          popup: 'listbox',
          expanded: 'false',
          name: 'Default for new agents',
          labelFor: 'Default for new agents',
        });
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        const state = await tab.evaluate(() => {
          const trigger = document.querySelector('#agent-default');
          const list = document.querySelector('[role=listbox]');
          const search = document.querySelector('[data-select-popover] input');
          const options = [...document.querySelectorAll('[role=option]')];
          const active = search?.getAttribute('aria-activedescendant') ?? '';
          return {
            expanded: trigger?.getAttribute('aria-expanded'),
            controls: trigger?.getAttribute('aria-controls') === list?.id && (list?.id ?? '') !== '',
            listName: list?.getAttribute('aria-label'),
            searchControls: search?.getAttribute('aria-controls') === list?.id,
            activeResolves: options.some(option => option.id === active),
            selected: options.filter(option => option.getAttribute('aria-selected') === 'true').length,
            allNamed: options.every(option => (option.textContent ?? '').trim() !== ''),
            groups: [...document.querySelectorAll('[role=group]')].map(group => group.getAttribute('aria-label')),
          };
        });
        expect(state).toEqual({
          expanded: 'true',
          controls: true,
          listName: 'Default for new agents',
          searchControls: true,
          activeResolves: true,
          selected: 1,
          allNamed: true,
          groups: ['Permissions'],
        });
      } finally {
        await close();
      }
    });

    it('should pass axe-core with the list open (the active hint included) and with the empty filter, and leave no aria-controls dangling', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        expect(await axeViolations(tab)).toEqual([]);
        await press(tab, variant);
        await tab.waitForSelector('[role=listbox]');
        expect(await tab.$('[role=option][data-active=true] .fy-sb__hint')).not.toBeNull();
        expect(await axeViolations(tab)).toEqual([]);
        await tab.keyboard.type('zzz');
        await tab.waitForSelector('[data-select-empty]');
        expect(await tab.$('[role=listbox]')).toBeNull();
        expect(await dangling(tab)).toEqual([]);
        expect(await axeViolations(tab)).toEqual([]);
      } finally {
        await close();
      }
    });

    it('should open the DIALOG in a 500px component container, and the popover in a 700px one, in the same 1280px window', async () => {
      const narrow = await open(variant, '&n=8&pane=500');
      try {
        await press(narrow.tab, variant);
        await narrow.tab.waitForSelector('[role=listbox]');
        const dialog = await box(narrow.tab, '[role=dialog]');
        const measure = await narrow.tab.evaluate(() => ({
          container: document.querySelector<HTMLElement>('[data-pane]')?.getBoundingClientRect().width ?? 0,
          window: window.innerWidth,
          popovers: document.querySelectorAll('[data-select-popover]').length,
        }));
        expect(measure).toEqual({ container: 500, window: 1_280, popovers: 0 });
        if (dialog === null) throw new Error('a 500px container did not open the dialog');
        expect(Math.abs(dialog.left + dialog.width / 2 - variant.width / 2)).toBeLessThanOrEqual(8);
        expect(Math.abs(dialog.top + dialog.height / 2 - variant.height / 2)).toBeLessThanOrEqual(8);
        await shotOf(narrow.tab, variant, 'pane-500-dialog');
      } finally {
        await narrow.close();
      }
      const wide = await open(variant, '&n=8&pane=700');
      try {
        await press(wide.tab, variant);
        await wide.tab.waitForSelector('[data-select-popover]');
        expect(await wide.tab.$('[role=dialog]')).toBeNull();
      } finally {
        await wide.close();
      }
    });
  });
}

for (const variant of [PHONE, PHONE_DARK, NARROW]) {
  describe(`SelectBox as a dialog (${variant.name})`, () => {
    it('should open a CENTRED dialog (within 8px of the viewport centre, both axes) with the search focused', async () => {
      const { tab, close } = await open(variant, '&n=60');
      try {
        await shotOf(tab, variant, 'closed');
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        await shotOf(tab, variant, 'dialog');
        const dialog = await box(tab, '[role=dialog]');
        if (dialog === null) throw new Error('no dialog');
        expect(Math.abs(dialog.left + dialog.width / 2 - variant.width / 2)).toBeLessThanOrEqual(8);
        expect(Math.abs(dialog.top + dialog.height / 2 - variant.height / 2)).toBeLessThanOrEqual(8);
        expect(dialog.width).toBeLessThanOrEqual(variant.width * 0.92 + 0.5);
        expect(dialog.height).toBeLessThanOrEqual(variant.height * 0.7 + 0.5);
        expect(await tab.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
        expect(await tab.$('[data-select-popover]')).toBeNull();
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await close();
      }
    });

    it('should ALWAYS have a focused search field in the dialog, even for 2 options: typing filters, Enter picks ONCE', async () => {
      const { tab, close } = await open(variant, '&n=2');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        await shotOf(tab, variant, 'dialog-two');
        const dialog = await box(tab, '[role=dialog]');
        if (dialog === null) throw new Error('no dialog');
        expect(Math.abs(dialog.left + dialog.width / 2 - variant.width / 2)).toBeLessThanOrEqual(8);
        expect(Math.abs(dialog.top + dialog.height / 2 - variant.height / 2)).toBeLessThanOrEqual(8);
        expect(await tab.$$('[role=dialog] input')).toHaveLength(1);
        expect(await tab.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
        expect(await optionLabels(tab)).toEqual(['Automatic', 'Auto-approve edits']);
        await tab.keyboard.type('approve');
        expect(await optionLabels(tab)).toEqual(['Auto-approve edits']);
        await shotOf(tab, variant, 'dialog-two-filtered');
        await tab.keyboard.press('Enter');
        await tab.waitForSelector('[role=dialog]', { state: 'detached' });
        expect(await picks(tab)).toEqual(['auto-approve']);
        expect(await focusedId(tab)).toBe('agent-default');
      } finally {
        await close();
      }
    });

    it('should pick a filtered 2-option row by a tap, onChange once', async () => {
      const { tab, close } = await open(variant, '&n=2');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        await tab.keyboard.type('approve');
        await hit(tab, variant, '[role=option]');
        await tab.waitForSelector('[role=dialog]', { state: 'detached' });
        expect(await picks(tab)).toEqual(['auto-approve']);
      } finally {
        await close();
      }
    });

    it('should honour an explicit searchable="never" in the dialog and keep 60 options searchable', async () => {
      const never = await open(variant, '&n=2&searchable=never');
      try {
        await press(never.tab, variant);
        await never.tab.waitForSelector('[role=dialog]');
        expect(await never.tab.$('[role=dialog] input')).toBeNull();
      } finally {
        await never.close();
      }
      const many = await open(variant, '&n=60');
      try {
        await press(many.tab, variant);
        await many.tab.waitForSelector('[role=dialog]');
        expect(await many.tab.$$('[role=dialog] input')).toHaveLength(1);
        expect(await many.tab.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
      } finally {
        await many.close();
      }
    });

    it('should scroll the list INSIDE the dialog and never the page behind, which is inert', async () => {
      const { tab, close } = await open(variant, '&n=60');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        const list = await box(tab, '[role=listbox]');
        if (list === null) throw new Error('no list');
        await tab.mouse.move(list.left + list.width / 2, list.top + list.height / 2);
        await tab.mouse.wheel(0, 6_000);
        await tab.waitForFunction(() => (document.querySelector('[role=listbox]')?.scrollTop ?? 0) > 0);
        expect(await tab.evaluate(() => window.scrollY)).toBe(0);
        const inert = await tab.evaluate(() => document.querySelector('#agent-default')?.closest('[inert]') !== null);
        expect(inert).toBe(true);
        const geometry = await tab.evaluate(() => {
          const element = document.querySelector<HTMLElement>('[role=listbox]');
          return element === null
            ? null
            : { overflows: element.scrollHeight > element.clientHeight, x: element.scrollWidth > element.clientWidth };
        });
        expect(geometry).toEqual({ overflows: true, x: false });
      } finally {
        await close();
      }
    });

    it('should show NO scroll bar for 5 options and one for 60', async () => {
      const few = await open(variant, '&n=5');
      try {
        await press(few.tab, variant);
        await few.tab.waitForSelector('[role=dialog]');
        const measure = async (tab: Page) =>
          await tab.evaluate(() => {
            const dialog = document.querySelector<HTMLElement>('[role=dialog]');
            const scrollers = [
              ...(dialog?.querySelectorAll<HTMLElement>('*') ?? []),
              ...(dialog === null ? [] : [dialog]),
            ].filter(
              element =>
                element.scrollHeight > element.clientHeight + 1 && getComputedStyle(element).overflowY !== 'visible',
            );
            const list = document.querySelector<HTMLElement>('[role=listbox]');
            const body = dialog?.querySelector<HTMLElement>('[data-dialog-body]');
            // The list reserves its scrollbar gutter (PR 2398: the selected row's check must not jump), so a bar's width proves nothing:
            // "no bar for 5 options" is the list FITTING with the COMPUTED overflow mode `auto` (a bar only when needed).
            return {
              scrollers: scrollers.length,
              listFits: list !== null && list.scrollHeight <= list.clientHeight,
              listOverflow:
                list === null ? '' : `${getComputedStyle(list).overflowY}/${getComputedStyle(list).overflowX}`,
              bodyOverflow: body === null || body === undefined ? '' : getComputedStyle(body).overflowY,
            };
          });
        expect(await measure(few.tab)).toEqual({
          scrollers: 0,
          listFits: true,
          listOverflow: 'auto/hidden',
          bodyOverflow: expect.stringMatching(/^(auto|hidden)$/),
        });
        await shotOf(few.tab, variant, 'dialog-few');
      } finally {
        await few.close();
      }
      const many = await open(variant, '&n=60');
      try {
        await press(many.tab, variant);
        await many.tab.waitForSelector('[role=dialog]');
        expect(
          await many.tab.evaluate(() => {
            const list = document.querySelector<HTMLElement>('[role=listbox]');
            return list !== null && list.scrollHeight > list.clientHeight;
          }),
        ).toBe(true);
      } finally {
        await many.close();
      }
    });

    it('should filter in the dialog, pick ONE value with a tap and give the focus back; Cancel picks nothing', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        await tab.keyboard.type('plan');
        expect(await optionLabels(tab)).toEqual(['Plan only']);
        await shotOf(tab, variant, 'dialog-filtered');
        await hit(tab, variant, '[role=option]');
        await tab.waitForSelector('[role=dialog]', { state: 'detached' });
        expect(await picks(tab)).toEqual(['plan']);
        expect(await focusedId(tab)).toBe('agent-default');
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        await hit(tab, variant, 'button:has-text("Cancel")');
        await tab.waitForSelector('[role=dialog]', { state: 'detached' });
        expect(await picks(tab)).toEqual(['plan']);
      } finally {
        await close();
      }
    });

    it('should name the dialog by the control label and mark the chosen option', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        const state = await tab.evaluate(() => {
          const dialog = document.querySelector('[role=dialog]');
          const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
          return {
            modal: dialog?.getAttribute('aria-modal'),
            name: title?.textContent,
            selected: [...document.querySelectorAll('[role=option][aria-selected=true] [data-label]')].map(
              o => o.textContent,
            ),
          };
        });
        expect(state).toEqual({ modal: 'true', name: 'Default for new agents', selected: ['Automatic'] });
      } finally {
        await close();
      }
    });

    it('should pass axe-core in the open dialog (the active hint included) and with the empty filter', async () => {
      const { tab, close } = await open(variant, '&n=8');
      try {
        await press(tab, variant);
        await tab.waitForSelector('[role=dialog]');
        expect(await tab.$('[role=option][data-active=true] .fy-sb__hint')).not.toBeNull();
        expect(await axeViolations(tab)).toEqual([]);
        await tab.keyboard.type('zzz');
        await tab.waitForSelector('[data-select-empty]');
        expect(await dangling(tab)).toEqual([]);
        expect(await axeViolations(tab)).toEqual([]);
      } finally {
        await close();
      }
    });
  });
}

describe('Dialog', () => {
  it('should size by its content with no scroll bar, centre itself and never overflow sideways', async () => {
    const { tab, close } = await open(DESKTOP, '&dialog=1&lines=3');
    try {
      await tab.click('[data-open]');
      await tab.waitForSelector('[role=dialog]');
      await shotOf(tab, DESKTOP, 'bare-dialog');
      const state = await tab.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('[role=dialog]');
        const body = dialog?.querySelector<HTMLElement>('[data-dialog-body]');
        if (dialog === undefined || dialog === null || body === null || body === undefined) return null;
        const rect = dialog.getBoundingClientRect();
        return {
          bodyFits: body.scrollHeight <= body.clientHeight,
          bar: body.offsetWidth - body.clientWidth,
          sideways: body.scrollWidth > body.clientWidth,
          dx: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
          dy: Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2),
          short: rect.height < window.innerHeight * 0.5,
          modal: dialog.getAttribute('aria-modal'),
          name: document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent,
        };
      });
      expect(state).toEqual({
        bodyFits: true,
        bar: 0,
        sideways: false,
        dx: expect.any(Number),
        dy: expect.any(Number),
        short: true,
        modal: 'true',
        name: 'A centred dialog',
      });
      expect(state?.dx ?? 99).toBeLessThanOrEqual(8);
      expect(state?.dy ?? 99).toBeLessThanOrEqual(8);
    } finally {
      await close();
    }
  });

  it('should scroll ONE container, only when the content overflows, within 70% of the window height', async () => {
    const { tab, close } = await open(DESKTOP, '&dialog=1&lines=80');
    try {
      await tab.click('[data-open]');
      await tab.waitForSelector('[role=dialog]');
      const state = await tab.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('[role=dialog]');
        const body = dialog?.querySelector<HTMLElement>('[data-dialog-body]');
        if (dialog === null || dialog === undefined || body === null || body === undefined) return null;
        const scrollers = [dialog, ...dialog.querySelectorAll<HTMLElement>('*')].filter(
          element =>
            element.scrollHeight > element.clientHeight + 1 &&
            ['auto', 'scroll'].includes(getComputedStyle(element).overflowY),
        );
        return {
          scrollers: scrollers.map(element => element.hasAttribute('data-dialog-body')),
          tall: dialog.getBoundingClientRect().height <= window.innerHeight * 0.7 + 1,
          overflowY: getComputedStyle(body).overflowY,
          overflowX: getComputedStyle(body).overflowX,
        };
      });
      expect(state).toEqual({ scrollers: [true], tall: true, overflowY: 'auto', overflowX: 'hidden' });
    } finally {
      await close();
    }
  });

  it('should close on Escape and return the focus, and keep Tab inside while open', async () => {
    const { tab, close } = await open(DESKTOP, '&dialog=1&lines=3');
    try {
      await tab.click('[data-open]');
      await tab.waitForSelector('[role=dialog]');
      for (let step = 0; step < 5; step += 1) {
        await tab.keyboard.press('Tab');
        expect(await tab.evaluate(() => document.activeElement?.closest('[role=dialog]') !== null)).toBe(true);
      }
      await tab.keyboard.press('Escape');
      await tab.waitForSelector('[role=dialog]', { state: 'detached' });
      expect(await tab.evaluate(() => document.activeElement?.hasAttribute('data-open'))).toBe(true);
    } finally {
      await close();
    }
  });
});
