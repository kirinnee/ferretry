/**
 * C59 O5 — the Claude Code sign-in panel, owner items 1, 2, 5, 6, 7, proven on computed geometry in a real browser over
 * fixed fake data (the same scene as `sign-in-harness.visual.test.ts`, `fixtures/sign-in-harness-scene.tsx`).
 *
 *  1. a button's busy mark never resizes it (idle and busy boxes are identical) and keeps >= 12 px to its neighbour;
 *  2. the how-to picture is not faded: its captions and its window edges hold their contrast;
 *  5. Finish sign-in: spinner on the button, every other button disabled while it runs, a visible "Signed in" at the end,
 *     and a refused code's message shakes (transform only), never under reduced motion;
 *  6. desktop: the picture is exactly the height of the options beside it, and reaches the card's right edge;
 *  7. phone and desktop: the options do not move when the state changes (busy, refused): offset 0.
 *
 * Set `FY_SIGN_IN_BALANCE_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`; the measured numbers go to `measured.json`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SIGN_IN_BALANCE_SHOTS_DIR ?? '';
const CODE = 'FAKE-CODE-0123456789abcdef#FAKE-STATE-xyz';
const CODE_FIELD = '#claude-login-code-claude-studio';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-sign-in-balance-'));
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
  if (shotsDir !== '') await Bun.write(join(shotsDir, 'measured.json'), JSON.stringify(measured, null, 2));
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
type Viewport = (typeof VIEWPORTS)[number];
type Theme = (typeof THEMES)[number];

const open = async (
  viewport: Viewport,
  theme: Theme,
  scene: string,
  options: { readonly reducedMotion?: 'reduce' | 'no-preference'; readonly hold?: number } = {},
) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    reducedMotion: options.reducedMotion ?? 'no-preference',
    colorScheme: theme === 'studio-dark' ? 'dark' : 'light',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=${theme}&case=${scene}&hold=${String(options.hold ?? 1_200)}`);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, viewport: Viewport, theme: string, name: string): Promise<void> => {
  // The picture's first frame fades in over 240 ms: a still is taken once it is up.
  await tab.waitForTimeout(500);
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${name}.png`) });
};

/** The box of the panel's first (primary) button and of its neighbour, and the gap between them. */
const buttonFacts = (tab: Page) =>
  tab.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-claude-login] button')].filter(
      button => button.getBoundingClientRect().width > 0 && !button.closest('[data-copy-button]'),
    );
    const boxes = buttons.map(button => {
      const box = button.getBoundingClientRect();
      return {
        label: button.innerText.trim(),
        left: box.left,
        right: box.right,
        top: box.top,
        w: box.width,
        h: box.height,
      };
    });
    return boxes;
  });

describe('item 1: the busy mark never resizes a button and never touches its neighbour', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`Sign in to Claude Code, idle vs "Starting sign-in…" (${viewport.name}, ${theme})`, async () => {
        const idle = await open(viewport, theme, 'claude-idle');
        const busy = await open(viewport, theme, 'claude-starting-direct');
        try {
          await idle.tab.locator('[data-claude-login] button').first().waitFor({ state: 'visible' });
          await busy.tab.locator('[data-claude-login] button').nth(1).waitFor({ state: 'visible' });
          const before = (await buttonFacts(idle.tab))[0]!;
          const during = await buttonFacts(busy.tab);
          const start = during[0]!;
          const over = during[1]!;
          // The phone stacks the two buttons, the desktop puts them in a row: the nearest distance between boxes counts.
          const gap = viewport.phone ? over.top - (start.top + start.h) : over.left - start.right;
          measured[`start-${viewport.name}-${theme}`] = { idle: before, busy: start, neighbour: over, gap };
          expect(Math.abs(start.w - before.w)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(start.h - before.h)).toBeLessThanOrEqual(0.5);
          expect(gap).toBeGreaterThanOrEqual(12);
          await shot(busy.tab, viewport, theme, 'claude-starting');
        } finally {
          await idle.close();
          await busy.close();
        }
      });
});

/** Where the options sit: their tops, so a state change that pushes any of them is a measured offset. */
const optionTops = (tab: Page) =>
  tab.evaluate(
    ({ field }) => {
      const top = (el: Element | null): number => (el === null ? Number.NaN : el.getBoundingClientRect().top);
      const host = document.querySelector('[data-claude-login-code]') as HTMLElement;
      return {
        steps: top(host.querySelector('[data-sign-in-steps]')),
        demo: top(host.querySelector('[data-sign-in-demo]')),
        label: top(host.querySelector('form label')),
        field: top(host.querySelector(field)),
        finish: top(host.querySelector('form button[type="submit"]')),
        scrollY: window.scrollY,
      };
    },
    { field: CODE_FIELD },
  );

describe('items 5 and 7: finishing the sign-in gives feedback and moves nothing', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`busy, then a refused code: every option stays put (${viewport.name}, ${theme})`, async () => {
        const { tab, problems, close } = await open(viewport, theme, 'claude-fail', { hold: 900 });
        try {
          await tab.locator(CODE_FIELD).waitFor({ state: 'visible' });
          const idle = await optionTops(tab);
          const idleButtons = await buttonFacts(tab);
          await tab.locator(CODE_FIELD).fill(CODE);
          await tab.locator('form button[type="submit"]').click();
          // The request is held: this is the page while it works.
          await tab.waitForFunction(
            () => document.querySelector('[data-claude-login] button[aria-busy="true"]') !== null,
          );
          const busy = await optionTops(tab);
          const busyButtons = await buttonFacts(tab);
          const enabled = await tab.evaluate(() =>
            [...document.querySelectorAll<HTMLButtonElement>('[data-claude-login] button')]
              .filter(b => !b.matches(':disabled'))
              .map(b => b.outerHTML.slice(0, 160)),
          );
          const spinners = await tab.locator('[data-claude-login] form button[type="submit"] [data-spinner]').count();
          await shot(tab, viewport, theme, 'claude-finishing');
          await tab.locator('[role="alert"]').first().waitFor({ state: 'visible' });
          const refused = await optionTops(tab);
          const finishAfter = (await buttonFacts(tab)).find(box => /Finish/u.test(box.label))!;
          await shot(tab, viewport, theme, 'claude-refused');
          const offsets = Object.fromEntries(
            (['steps', 'demo', 'label', 'field', 'finish'] as const).map(key => [
              key,
              { busy: busy[key] - idle[key], refused: refused[key] - idle[key] },
            ]),
          );
          const finishIdle = idleButtons.find(box => /Finish/u.test(box.label))!;
          const finishBusy = busyButtons.find(box => box.w > 0 && box.top === finishIdle.top)!;
          measured[`finish-${viewport.name}-${theme}`] = {
            offsets,
            finishIdle,
            finishBusy,
            finishAfter,
            enabledWhileBusy: enabled,
            spinners,
          };
          for (const key of ['steps', 'demo', 'label', 'field', 'finish'] as const) {
            expect(Math.abs(busy[key] - idle[key])).toBeLessThanOrEqual(0.5);
            expect(Math.abs(refused[key] - idle[key])).toBeLessThanOrEqual(0.5);
          }
          expect(Math.abs(finishBusy.w - finishIdle.w)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(finishBusy.h - finishIdle.h)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(finishAfter.w - finishIdle.w)).toBeLessThanOrEqual(0.5);
          expect(enabled).toEqual([]);
          expect(spinners).toBe(1);
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });

  for (const reducedMotion of ['no-preference', 'reduce', 'data-motion'] as const)
    it(`a refused code shakes its message with transform only; never under reduced motion (${reducedMotion})`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], 'studio-light', 'claude-fail', {
        hold: 200,
        reducedMotion: reducedMotion === 'reduce' ? 'reduce' : 'no-preference',
      });
      try {
        await tab.locator(CODE_FIELD).waitFor({ state: 'visible' });
        if (reducedMotion === 'data-motion')
          await tab.evaluate(() => (document.documentElement.dataset['motion'] = 'reduced'));
        await tab.locator(CODE_FIELD).fill(CODE);
        await tab.locator('form button[type="submit"]').click();
        const alert = tab.locator('[data-claude-login] [role="alert"]').first();
        await alert.waitFor({ state: 'visible' });
        const facts = await alert.evaluate(element => {
          const animations = element.getAnimations().filter(a => a instanceof CSSAnimation) as CSSAnimation[];
          const props = new Set<string>();
          for (const a of animations)
            for (const frame of (a.effect as KeyframeEffect).getKeyframes())
              for (const key of Object.keys(frame))
                if (!['offset', 'easing', 'composite', 'computedOffset'].includes(key)) props.add(key);
          return { names: animations.map(a => a.animationName), props: [...props], text: element.textContent ?? '' };
        });
        measured[`shake-${reducedMotion}`] = facts;
        expect(facts.text).toContain('did not accept');
        if (reducedMotion === 'no-preference') {
          expect(facts.names).toContain('fy-shake');
          expect(facts.props).toEqual(['transform']);
        } else expect(facts.names).toEqual([]);
      } finally {
        await close();
      }
    });

  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`an accepted code ends on a clear "Signed in" (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, 'claude-done', { hold: 200 });
        try {
          await tab.locator(CODE_FIELD).waitFor({ state: 'visible' });
          await tab.locator(CODE_FIELD).fill(CODE);
          await tab.locator('form button[type="submit"]').click();
          const status = tab.locator('[data-claude-login="complete"] [role="status"]');
          await status.waitFor({ state: 'visible' });
          const facts = await status.evaluate(element => ({
            text: (element as HTMLElement).innerText,
            hasIcon: element.querySelector('svg') !== null,
            height: element.getBoundingClientRect().height,
          }));
          measured[`signed-in-${viewport.name}-${theme}`] = facts;
          expect(facts.text).toMatch(/^Signed in/u);
          expect(facts.hasIcon).toBe(true);
          await shot(tab, viewport, theme, 'claude-signed-in');
        } finally {
          await close();
        }
      });
});

describe('item 6: on a desktop the picture is as tall as the options beside it', () => {
  for (const theme of THEMES)
    it(`top and bottom match the options; the picture reaches the card's right edge (1280, ${theme})`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], theme, 'claude-code');
      try {
        await tab.locator('[data-claude-login-code] [data-sign-in-demo]').waitFor({ state: 'visible' });
        const facts = await tab.evaluate(() => {
          const host = document.querySelector('[data-claude-login-code]') as HTMLElement;
          const demo = host.querySelector('[data-sign-in-demo]')!.getBoundingClientRect();
          const steps = host.querySelector('[data-sign-in-steps]')!.getBoundingClientRect();
          const form = host.querySelector('form')!.getBoundingClientRect();
          const hostBox = host.getBoundingClientRect();
          return {
            demoTop: demo.top,
            demoBottom: demo.bottom,
            optionsTop: steps.top,
            optionsBottom: form.bottom,
            demoRight: demo.right,
            hostRight: hostBox.right,
            demoWidth: demo.width,
          };
        });
        measured[`demo-height-${theme}`] = facts;
        expect(Math.abs(facts.demoTop - facts.optionsTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(facts.demoBottom - facts.optionsBottom)).toBeLessThanOrEqual(1);
        expect(Math.abs(facts.demoRight - facts.hostRight)).toBeLessThanOrEqual(1);
        expect(facts.demoWidth).toBeGreaterThan(300);
        await shot(tab, VIEWPORTS[0], theme, 'claude-code');
      } finally {
        await close();
      }
    });
});

/** WCAG relative luminance of a computed `rgb()/rgba()` colour. */
const luminance = (css: string): number => {
  const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
  const lin = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('item 2: the how-to picture is not faded', () => {
  for (const theme of THEMES)
    it(`captions are text-strong and the window edge is a real edge (${theme})`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], theme, 'claude-code', { reducedMotion: 'reduce' });
      try {
        await tab.locator('[data-sign-in-demo]').waitFor({ state: 'visible' });
        const facts = await tab.evaluate(() => {
          const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
          const caption = getComputedStyle(demo.querySelector('figcaption') as HTMLElement);
          const windowEl = getComputedStyle(demo.querySelector('.fy-sd__window') as HTMLElement);
          const bar = getComputedStyle(demo.querySelector('.fy-sd__bar i') as HTMLElement);
          const body = getComputedStyle(document.body);
          return {
            captionColor: caption.color,
            captionSize: caption.fontSize,
            windowBorder: windowEl.borderTopColor,
            windowBg: windowEl.backgroundColor,
            dot: bar.backgroundColor,
            bodyBg: body.backgroundColor,
            frameOpacity: getComputedStyle(demo.querySelector('[data-frame="1"]') as HTMLElement).opacity,
          };
        });
        const captionContrast = contrast(facts.captionColor, facts.bodyBg);
        const edgeContrast = contrast(facts.windowBorder, facts.bodyBg);
        measured[`demo-contrast-${theme}`] = { ...facts, captionContrast, edgeContrast };
        expect(captionContrast).toBeGreaterThanOrEqual(7);
        expect(edgeContrast).toBeGreaterThanOrEqual(3);
        expect(Number(facts.frameOpacity)).toBe(1);
      } finally {
        await close();
      }
    });
});

describe('item 3: the long link is one line until "Show full" opens it', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`cut short with an ellipsis, then whole, then cut again (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, 'claude-code');
        try {
          const link = tab.locator('[data-sign-in-link]');
          await link.waitFor({ state: 'visible' });
          const toggle = tab.locator('[data-sign-in-link-toggle]');
          const read = () =>
            link.evaluate(element => {
              const style = getComputedStyle(element);
              return {
                height: element.getBoundingClientRect().height,
                lineHeight: Number.parseFloat(style.lineHeight),
                clipped: element.scrollWidth > element.clientWidth,
                overflow: style.textOverflow,
                scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              };
            });
          const short = await read();
          await shot(tab, viewport, theme, 'claude-link-short');
          await toggle.click();
          const full = await read();
          await shot(tab, viewport, theme, 'claude-link-full');
          await toggle.click();
          const again = await read();
          measured[`link-${viewport.name}-${theme}`] = { short, full, again };
          expect(await toggle.textContent()).toBe('Show full');
          expect(short.overflow).toBe('ellipsis');
          expect(short.clipped).toBe(true);
          // One line of text plus the box's own padding and border.
          expect(short.height).toBeLessThanOrEqual(short.lineHeight + 24);
          expect(full.height).toBeGreaterThanOrEqual(short.height + short.lineHeight - 1);
          expect(Math.abs(again.height - short.height)).toBeLessThanOrEqual(0.5);
          expect(full.scrollX).toBeLessThanOrEqual(0);
        } finally {
          await close();
        }
      });
});

describe('audit row: Finish sign-in fills the width under the field, with a balanced secondary row', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`Finish is the field's width; Start over and Cancel are equal halves (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, 'claude-code');
        try {
          await tab.locator(CODE_FIELD).waitFor({ state: 'visible' });
          const facts = await tab.evaluate(field => {
            const box = (el: Element | null) => {
              const r = (el as HTMLElement).getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, w: r.width };
            };
            const secondary = [...document.querySelectorAll('[data-sign-in-secondary] button')].map(box);
            return {
              field: box(document.querySelector(field)),
              finish: box(document.querySelector('form button[type="submit"]')),
              secondary,
            };
          }, CODE_FIELD);
          measured[`actions-${viewport.name}-${theme}`] = facts;
          expect(Math.abs(facts.finish.w - facts.field.w)).toBeLessThanOrEqual(1);
          expect(Math.abs(facts.finish.left - facts.field.left)).toBeLessThanOrEqual(1);
          expect(facts.secondary).toHaveLength(2);
          expect(Math.abs(facts.secondary[0]!.w - facts.secondary[1]!.w)).toBeLessThanOrEqual(1);
          expect(Math.abs(facts.secondary[0]!.left - facts.field.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(facts.secondary[1]!.right - facts.field.right)).toBeLessThanOrEqual(1);
          expect(facts.secondary[0]!.top).toBeGreaterThan(facts.finish.top);
          expect(facts.secondary[1]!.left - facts.secondary[0]!.right).toBeGreaterThanOrEqual(12 - 1);
          await shot(tab, viewport, theme, 'claude-actions');
        } finally {
          await close();
        }
      });
});
