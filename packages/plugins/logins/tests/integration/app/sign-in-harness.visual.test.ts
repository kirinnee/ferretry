/**
 * r11 O6 — the harness sign-in, proven in a real browser over fake data (`fixtures/sign-in-harness-scene.tsx`):
 *
 *  - item 6 "why in codex' segment, it ask you to use claude code?": the add panel locked to Codex has no tool picker and
 *    does not say "Claude" anywhere;
 *  - item 7 "default to link when signing in with codex": with no choice made, the first request carries `method: link`
 *    and the start button says so;
 *  - item 8 "instruction too wordy, maybe show a animation of what to do?": while a sign-in waits there is an animated
 *    demo BESIDE the steps at 1280 (its left edge clear of the steps' right edge, its top level with theirs) and below
 *    them at 390 with no sideways scroll; its three frames really take turns (each shown alone at 1.5 s / 4.5 s / 7.5 s
 *    of the loop), the third types; the step text is short; under reduced motion the frames sit side by side, still.
 *
 * Set `FY_SIGN_IN_HARNESS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SIGN_IN_HARNESS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;
/** What the asserts measured, written next to the shots (numbers for the PR body). */
const measured: Record<string, unknown> = {};

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-sign-in-harness-'));
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

const open = async (
  viewport: Viewport,
  theme: (typeof THEMES)[number],
  scene: string,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    reducedMotion,
    colorScheme: theme === 'studio-dark' ? 'dark' : 'light',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=${theme}&case=${scene}`);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, viewport: Viewport, theme: string, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${name}.png`) });
};

describe('Codex: the add panel is Codex’s own, and a link is the default', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`has no tool picker and never says Claude (${viewport.name}, ${theme})`, async () => {
        const { tab, problems, close } = await open(viewport, theme, 'codex-add');
        try {
          await tab.locator('[data-harness-sign-in]').waitFor({ state: 'visible' });
          const facts = await tab.evaluate(() => ({
            radios: document.querySelectorAll('input[type="radio"], [role="radiogroup"]').length,
            text: document.body.innerText,
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }));
          expect(facts.radios).toBe(0);
          expect(facts.text).not.toMatch(/claude/iu);
          expect(facts.text).toContain('Sign in to Codex');
          expect(facts.scrollX).toBeLessThanOrEqual(0);
          await shot(tab, viewport, theme, 'codex-add');
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }

  it('starts with a link on the very first press, and says so on the button', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', 'codex-start');
    try {
      const button = tab.locator('[data-change-submit]');
      await button.waitFor({ state: 'visible' });
      expect(await button.innerText()).toContain('with a link');
      await tab.waitForFunction(() => !(document.querySelector('[data-change-submit]') as HTMLButtonElement).disabled);
      await button.click();
      await tab.locator('[data-codex-login-callback]').waitFor({ state: 'visible' });
      const calls = await tab.evaluate(
        () => (window as unknown as { __calls: { route: string; body: unknown }[] }).__calls,
      );
      expect(calls.find(call => call.route === 'POST /v1/logins/sign-in')?.body).toEqual({
        loginId: 'codex-studio',
        method: 'link',
      });
    } finally {
      await close();
    }
  });
});

const SCENES = [
  { scene: 'codex-link', host: '[data-codex-login-callback]', kind: 'address' },
  { scene: 'claude-code', host: '[data-claude-login-code]', kind: 'code' },
] as const;

/** The step text of a waiting sign-in, without the link, the field and the buttons: what a person has to READ. */
const readableWords = (selector: string): number => {
  const host = document.querySelector<HTMLElement>(selector);
  if (host === null) return -1;
  const clone = host.cloneNode(true) as HTMLElement;
  for (const drop of clone.querySelectorAll('code, textarea, button, [data-sign-in-demo], figure')) drop.remove();
  return clone.innerText.split(/\s+/u).filter(Boolean).length;
};

describe('a waiting sign-in shows what to do instead of explaining it', () => {
  for (const { scene, host, kind } of SCENES) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        it(`${scene}: the demo is ${viewport.phone ? 'below' : 'beside'} the steps, and its frames take turns (${viewport.name}, ${theme})`, async () => {
          const { tab, problems, close } = await open(viewport, theme, scene);
          try {
            await tab.locator(`${host} [data-sign-in-demo="${kind}"]`).waitFor({ state: 'visible' });
            const layout = await tab.evaluate(
              ({ hostSelector }) => {
                const hostEl = document.querySelector(hostSelector) as HTMLElement;
                const demo = hostEl.querySelector('[data-sign-in-demo]') as HTMLElement;
                const steps = demo.previousElementSibling as HTMLElement;
                const d = demo.getBoundingClientRect();
                const s = steps.getBoundingClientRect();
                return {
                  demoLeft: d.left,
                  demoTop: d.top,
                  demoWidth: d.width,
                  demoHeight: d.height,
                  stepsRight: s.right,
                  stepsTop: s.top,
                  stepsBottom: s.bottom,
                  scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                  viewport: window.innerWidth,
                };
              },
              { hostSelector: host },
            );
            if (viewport.phone) {
              expect(layout.demoTop).toBeGreaterThanOrEqual(layout.stepsBottom - 1);
              expect(layout.demoWidth).toBeLessThanOrEqual(layout.viewport - 32);
            } else {
              expect(layout.demoLeft).toBeGreaterThan(layout.stepsRight + 8);
              expect(Math.abs(layout.demoTop - layout.stepsTop)).toBeLessThanOrEqual(4);
            }
            measured[`${scene}-${viewport.name}-${theme}`] = layout;
            expect(layout.demoHeight).toBeGreaterThan(100);
            expect(layout.scrollX).toBeLessThanOrEqual(0);

            // Frame turns: pause every animation and read the opacity at three points of the 9 s loop.
            const turns = await tab.evaluate(() => {
              const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
              const animations = document
                .getAnimations()
                .filter(a => demo.contains((a.effect as KeyframeEffect).target));
              for (const a of animations) a.pause();
              const frames = [...demo.querySelectorAll<HTMLElement>('[data-frame]')];
              const field = demo.querySelector('.fy-sd__field') as HTMLElement;
              const typed = demo.querySelector('.fy-sd__typed') as HTMLElement;
              const at = (ms: number) => {
                for (const a of animations) a.currentTime = ms;
                return {
                  shown: frames.filter(f => Number(getComputedStyle(f).opacity) > 0.9).map(f => f.dataset['frame']),
                  typed: typed.getBoundingClientRect().width / Math.max(1, field.getBoundingClientRect().width - 18),
                };
              };
              return { count: animations.length, one: at(1_500), two: at(4_500), three: at(8_500), early: at(6_300) };
            });
            expect(turns.count).toBeGreaterThanOrEqual(4);
            expect(turns.one.shown).toEqual(['1']);
            expect(turns.two.shown).toEqual(['2']);
            expect(turns.three.shown).toEqual(['3']);
            expect(turns.early.typed).toBeLessThan(0.1);
            expect(turns.three.typed).toBeGreaterThan(0.9);

            // Few words: the steps a person reads (not the link, field or buttons).
            const words = await tab.evaluate(readableWords, host);
            measured[`${scene}-${viewport.name}-${theme}-words`] = words;
            expect(words).toBeGreaterThan(0);
            expect(words).toBeLessThanOrEqual(kind === 'address' ? 40 : 28);
            await tab.evaluate(() => {
              for (const a of document.getAnimations()) a.play();
            });
            await shot(tab, viewport, theme, scene);
            expect(problems).toEqual([]);
          } finally {
            await close();
          }
        });
      }
    }
  }

  it('under reduced motion the three frames sit side by side and nothing moves', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', 'codex-link', 'reduce');
    try {
      await tab.locator('[data-sign-in-demo]').waitFor({ state: 'visible' });
      const facts = await tab.evaluate(() => {
        const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
        const frames = [...demo.querySelectorAll<HTMLElement>('[data-frame]')].map(frame => {
          const box = frame.getBoundingClientRect();
          return { left: box.left, top: box.top, opacity: Number(getComputedStyle(frame).opacity) };
        });
        return {
          frames,
          running: document.getAnimations().filter(a => demo.contains((a.effect as KeyframeEffect).target)).length,
        };
      });
      expect(facts.running).toBe(0);
      expect(facts.frames.map(frame => frame.opacity)).toEqual([1, 1, 1]);
      expect(new Set(facts.frames.map(frame => Math.round(frame.top))).size).toBe(1);
      expect(facts.frames[0]!.left).toBeLessThan(facts.frames[1]!.left);
      expect(facts.frames[1]!.left).toBeLessThan(facts.frames[2]!.left);
    } finally {
      await close();
    }
  });
});
