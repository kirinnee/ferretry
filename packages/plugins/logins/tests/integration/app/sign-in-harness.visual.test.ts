/**
 * r11 O6 — the harness sign-in, proven in a real browser over fake data (`fixtures/sign-in-harness-scene.tsx`). The add
 * panels here are the REGISTERED panels mounted with the planned subject (`harness:codex`, `harness:claude`):
 *
 *  - item 6 "why in codex' segment, it ask you to use claude code?": no tool picker, never says "Claude"; the optional
 *    name and "Other ways to sign in" are folded (closed, then openable), the grid holds only Codex's providers, and
 *    Settings (no subject) keeps its full chooser;
 *  - item 7 "default to link when signing in with codex": the first request carries `method: link`; when that auto-started
 *    sign-in FAILS the device-code route is still offered and its request is the device-code one;
 *  - item 8 "instruction too wordy, maybe show a animation of what to do?": four frames played ONCE (open, sign in, copy
 *    the address bar with `http://localhost…` highlighted, paste) and left on the last; the picture sits before the paste
 *    field (on a phone it is on screen with it), beside the steps at 1280; four stills under reduced motion;
 *  - the secret path: the link on screen is the one the fake daemon sent; a submitted address is cleared at once and is
 *    in neither storage, the page nor the console.
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
/** The scene's script, to prove no stand-in client id is compiled into it. */
let bundle = '';
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
  bundle = js;
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
  /** Everything the page wrote to its console, any level: a pasted address must be in none of it. */
  const consoleLines: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  tab.on('console', message => consoleLines.push(message.text()));
  await tab.goto(`${origin}/?theme=${theme}&case=${scene}`);
  return { tab, problems, consoleLines, close: async () => await context.close() };
};

const shot = async (tab: Page, viewport: Viewport, theme: string, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${name}.png`) });
};

/** What the page's own request log holds (the scene records every call the client received). */
type Logged = { route: string; body: unknown };
const calls = async (tab: Page): Promise<Logged[]> =>
  await tab.evaluate(() => (window as unknown as { __calls: Logged[] }).__calls);

const DAEMON_LINK =
  'https://auth.example.test/oauth/authorize?response_type=code&state=unique-3c9d1e7a&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
const FAKE_ADDRESS = 'http://localhost:1455/auth/callback?code=FAKE-CALLBACK-CODE-7f3a91&state=unique-3c9d1e7a';
const FAKE_SECRET = 'FAKE-CALLBACK-CODE-7f3a91';

describe('the add panel, mounted as a page mounts it (registered panel, subject harness:codex / harness:claude)', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const [scene, name, other] of [
        ['codex-add', 'Codex', /claude/iu],
        ['claude-add', 'Claude Code', /codex/iu],
      ] as const) {
        it(`${scene}: no tool picker, never says ${other.source}, name and other ways are folded (${viewport.name}, ${theme})`, async () => {
          const { tab, problems, close } = await open(viewport, theme, scene);
          try {
            await tab.locator('[data-add-login-locked]').waitFor({ state: 'visible' });
            await tab.locator('[data-harness-sign-in]').waitFor({ state: 'visible' });
            const facts = await tab.evaluate(() => {
              const visible = (selector: string): boolean => {
                const element = document.querySelector<HTMLElement>(selector);
                if (element === null) return false;
                // A closed <details> keeps its content out of the render: not "visible", though it has a box in the tree.
                return element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
              };
              return {
                radios: document.querySelectorAll('input[type="radio"], [role="radiogroup"]').length,
                text: document.body.innerText,
                gridVisible: visible('[data-provider-grid]'),
                nameOpen: (document.querySelector('[data-add-login-name]') as HTMLDetailsElement | null)?.open,
                waysOpen: (document.querySelector('[data-add-login-other-ways]') as HTMLDetailsElement | null)?.open,
                nameField: visible('[data-add-login-name] input'),
                scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              };
            });
            measured[`${scene}-${viewport.name}-${theme}`] = facts;
            expect(facts.radios).toBe(0);
            expect(facts.text).not.toMatch(other);
            expect(facts.text).toContain(`Sign in to ${name}`);
            expect(facts.text).toContain('Name it (optional)');
            expect(facts.text).toContain('Other ways to sign in');
            expect(facts.nameOpen).toBe(false);
            expect(facts.waysOpen).toBe(false);
            expect(facts.nameField).toBe(false);
            expect(facts.gridVisible).toBe(false);
            expect(facts.scrollX).toBeLessThanOrEqual(0);
            expect((await calls(tab)).some(call => call.route === 'GET /v1/logins/presets')).toBe(false);
            await shot(tab, viewport, theme, scene);
            expect(problems).toEqual([]);
          } finally {
            await close();
          }
        });
      }
    }
  }

  it('opening the folds shows the name field and ONLY this tool’s providers; the typed name goes on the login it makes', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', 'codex-add');
    try {
      await tab.locator('[data-add-login-name] summary').click();
      await tab.locator('[data-add-login-name] input').fill('work');
      await tab.locator('[data-add-login-other-ways] summary').click();
      await tab.locator('[data-provider-grid]').waitFor({ state: 'visible' });
      const tiles = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-provider-tile]')].map(tile => tile.getAttribute('data-provider-tile')),
      );
      measured['codex-add-tiles'] = tiles;
      expect(tiles).toContain('ollama-local');
      expect(tiles).toContain('azure-openai');
      expect(tiles).not.toContain('zai-glm');
      expect(await tab.evaluate(() => document.body.innerText)).not.toMatch(/claude/iu);
      // No second "Sign in to a tool" picker came with the providers.
      expect(await tab.locator('input[type="radio"]').count()).toBe(0);
      await shot(tab, VIEWPORTS[0], 'studio-light', 'codex-add-open');
      await tab.locator('[data-change-submit]').first().click();
      await tab.waitForFunction(() =>
        (window as unknown as { __calls: { route: string }[] }).__calls.some(
          c => c.route === 'POST /v1/logins/changes/:changeId/apply',
        ),
      );
      const staged = (await calls(tab)).find(call => call.route === 'POST /v1/logins/changes');
      expect(staged?.body).toMatchObject({ kind: 'login.add', harness: 'codex', label: 'work' });
    } finally {
      await close();
    }
  });

  for (const [scene, name, own, other, half] of [
    ['codex-add', 'Codex', 'OPENAI_', /ANTHROPIC_|claude/iu, 'codex'],
    ['claude-add', 'Claude Code', 'ANTHROPIC_', /OPENAI_|codex/iu, 'claude-code'],
  ] as const) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        it(`${scene}: a SHARED provider (OpenRouter) shows and sends only ${name}'s half, in the tile, the form and the request (${viewport.name}, ${theme})`, async () => {
          const { tab, problems, close } = await open(viewport, theme, scene);
          try {
            await tab.locator('[data-add-login-other-ways] summary').click();
            const tile = tab.locator('[data-provider-tile="openrouter"]');
            await tile.waitFor({ state: 'visible' });
            await shot(tab, viewport, theme, `${scene}-shared-grid`);
            const tileScope = await tile.locator('[data-login-scope]').getAttribute('data-login-scope');
            await tile.click();
            const head = tab.locator('[data-add-login-preset="openrouter"]');
            await head.waitFor({ state: 'visible' });
            const headScope = await head.locator('[data-login-scope]').getAttribute('data-login-scope');
            // The full form: every field the person would see.
            await tab.locator('[data-quick-key-form], [data-add-login-form]').first().waitFor({ state: 'visible' });
            if ((await tab.locator('[data-quick-key-more]').count()) > 0)
              await tab.locator('[data-quick-key-more]').click();
            await tab.locator('[data-add-login-form="openrouter"]').waitFor({ state: 'visible' });
            const fields = await tab.evaluate(() =>
              [...document.querySelectorAll('[data-add-login-form] .fy-lg-field > span.font-mono')].map(
                el => el.textContent,
              ),
            );
            const text = await tab.evaluate(() => document.querySelector('[data-add-login-locked]')?.textContent ?? '');
            await shot(tab, viewport, theme, `${scene}-shared-form`);
            await tab.locator('[data-add-login-form] [data-change-submit]').click();
            await tab.waitForFunction(() =>
              (window as unknown as { __calls: { route: string }[] }).__calls.some(
                c => c.route === 'POST /v1/logins/changes',
              ),
            );
            const staged = (await calls(tab)).filter(call => call.route === 'POST /v1/logins/changes').at(-1)?.body as {
              harness: string;
              halves?: string[];
              env: Record<string, string>;
            };
            measured[`${scene}-shared-${viewport.name}-${theme}`] = {
              tileScope,
              headScope,
              fields,
              halves: staged.halves,
              env: Object.keys(staged.env),
            };
            expect(tileScope).toBe(half);
            expect(headScope).toBe(tileScope);
            expect(fields.length).toBeGreaterThan(0);
            for (const field of fields) expect(field).toStartWith(own);
            expect(text).not.toMatch(other);
            expect(staged.harness).toBe(half);
            expect(staged.halves).toEqual([half]);
            expect(Object.keys(staged.env).length).toBeGreaterThan(0);
            for (const key of Object.keys(staged.env)) expect(key).toStartWith(own);
            expect(problems).toEqual([]);
          } finally {
            await close();
          }
        });
      }
    }
  }

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`Settings › Logins (no subject) keeps its full chooser and provider grid (${viewport.name}, ${theme})`, async () => {
        const { tab, problems, close } = await open(viewport, theme, 'settings-add');
        try {
          await tab.locator('[data-provider-grid]').waitFor({ state: 'visible' });
          const facts = await tab.evaluate(() => ({
            radios: document.querySelectorAll('input[type="radio"]').length,
            locked: document.querySelector('[data-add-login-locked]') !== null,
            text: document.body.innerText,
            scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }));
          measured[`settings-add-${viewport.name}-${theme}`] = { radios: facts.radios, scrollX: facts.scrollX };
          expect(facts.locked).toBe(false);
          expect(facts.radios).toBe(2);
          expect(facts.text).toMatch(/claude code/iu);
          expect(facts.text).toMatch(/codex/iu);
          expect(facts.scrollX).toBeLessThanOrEqual(0);
          await shot(tab, viewport, theme, 'settings-add');
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }
});

describe('Codex: a link is the default, and the device code stays a way back', () => {
  it('starts with a link on the very first press, and says so on the button', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', 'codex-start');
    try {
      const button = tab.locator('[data-change-submit]');
      await button.waitFor({ state: 'visible' });
      expect(await button.innerText()).toContain('with a link');
      await tab.waitForFunction(() => !(document.querySelector('[data-change-submit]') as HTMLButtonElement).disabled);
      await button.click();
      await tab.locator('[data-codex-login-callback]').waitFor({ state: 'visible' });
      expect((await calls(tab)).find(call => call.route === 'POST /v1/logins/sign-in')?.body).toEqual({
        loginId: 'codex-studio',
        method: 'link',
      });
    } finally {
      await close();
    }
  });

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`a made login auto-starts with a link; when that FAILS, a device code is offered and its request is sent (${viewport.name}, ${theme})`, async () => {
        const { tab, problems, close } = await open(viewport, theme, 'codex-made');
        try {
          const make = tab.locator('[data-harness-sign-in] [data-change-submit]');
          await make.waitFor({ state: 'visible' });
          await tab.waitForFunction(
            () =>
              !(document.querySelector('[data-harness-sign-in] [data-change-submit]') as HTMLButtonElement).disabled,
          );
          await make.click();
          const useCode = tab.locator('[data-codex-login-use-device-code]');
          await useCode.waitFor({ state: 'visible' });
          const failed = await calls(tab);
          const first = failed.filter(call => call.route === 'POST /v1/logins/sign-in');
          expect(first.map(call => call.body)).toEqual([{ loginId: 'codex-login', method: 'link' }]);
          expect(await tab.locator('[data-codex-login="failed"]').count()).toBe(1);
          await shot(tab, viewport, theme, 'codex-made-failed');
          await useCode.click();
          await tab.locator('[data-codex-login="awaiting-approval"]').waitFor({ state: 'visible' });
          const starts = (await calls(tab)).filter(call => call.route === 'POST /v1/logins/sign-in');
          measured[`codex-made-${viewport.name}-${theme}`] = starts.map(call => call.body);
          // The device-code request carries no `method`: the daemon's default is the device code; `restart` ends the failed one.
          expect(starts.map(call => call.body)).toEqual([
            { loginId: 'codex-login', method: 'link' },
            { loginId: 'codex-login', restart: true },
          ]);
          expect(await tab.locator('[data-codex-login-user-code]').innerText()).toMatch(/^\w{4}-\w{5}$/u);
          await shot(tab, viewport, theme, 'codex-device');
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }
});

describe('the link on screen is the daemon’s, and what is pasted back is kept nowhere', () => {
  it('shows exactly the link the fake daemon sent; the app bundle holds no stand-in client id', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', 'codex-link');
    try {
      await tab.locator('[data-codex-login-callback]').waitFor({ state: 'visible' });
      const shown = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-codex-login-callback] code')].map(code => code.textContent),
      );
      measured['codex-link-shown'] = shown;
      expect(shown.filter(text => text === DAEMON_LINK)).toHaveLength(1);
      expect(shown.some(text => /app_fake|client_id/u.test(text ?? ''))).toBe(false);
      expect(bundle).not.toContain('app_fake');
    } finally {
      await close();
    }
  });

  it('a submitted address is cleared the moment it is sent, and is in neither storage, the page nor the console', async () => {
    const { tab, consoleLines, close } = await open(VIEWPORTS[0], 'studio-light', 'codex-link');
    try {
      const field = tab.locator('[data-codex-login-callback] textarea');
      await field.waitFor({ state: 'visible' });
      await tab.evaluate(() => {
        localStorage.setItem('probe', '1');
        sessionStorage.setItem('probe', '1');
      });
      await field.fill(FAKE_ADDRESS);
      expect(await field.inputValue()).toBe(FAKE_ADDRESS);
      await tab.locator('[data-codex-login-callback] button[type="submit"]').click();
      // The fake daemon holds the answer for 1.2 s: this is the request IN FLIGHT.
      await tab.waitForFunction(() =>
        (window as unknown as { __calls: { route: string }[] }).__calls.some(
          c => c.route === 'POST /v1/logins/sign-in/:flowId',
        ),
      );
      const inFlight = await tab.evaluate(
        secret => ({
          field:
            (document.querySelector('[data-codex-login-callback] textarea') as HTMLTextAreaElement | null)?.value ??
            '(gone)',
          html: document.documentElement.outerHTML.includes(secret),
          text: document.body.innerText.includes(secret),
          values: [...document.querySelectorAll('input, textarea')].some(el =>
            (el as HTMLInputElement).value.includes(secret),
          ),
        }),
        FAKE_SECRET,
      );
      expect(inFlight.field === '' || inFlight.field === '(gone)').toBe(true);
      expect(inFlight.html).toBe(false);
      expect(inFlight.text).toBe(false);
      expect(inFlight.values).toBe(false);
      await tab.locator('[data-codex-login="finishing"]').waitFor({ state: 'visible' });
      const after = await tab.evaluate(secret => {
        const dump = (storage: Storage): string => JSON.stringify(Object.fromEntries(Object.entries(storage)));
        return {
          local: dump(localStorage),
          session: dump(sessionStorage),
          html: document.documentElement.outerHTML.includes(secret),
          text: document.body.innerText.includes(secret),
          keys: [localStorage.length, sessionStorage.length],
        };
      }, FAKE_SECRET);
      const sent = (await calls(tab)).filter(call => call.route === 'POST /v1/logins/sign-in/:flowId');
      measured['codex-submit'] = {
        sentOnce: sent.length,
        fieldAtSettle: inFlight.field,
        storageEntries: after.keys,
        consoleLines: consoleLines.length,
      };
      // It WAS sent, once, to the daemon — and is held nowhere else.
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0]?.body)).toContain(FAKE_SECRET);
      expect(after.local).not.toContain(FAKE_SECRET);
      expect(after.session).not.toContain(FAKE_SECRET);
      expect(after.html).toBe(false);
      expect(after.text).toBe(false);
      expect(consoleLines.some(line => line.includes(FAKE_SECRET) || line.includes('localhost:1455'))).toBe(false);
    } finally {
      await close();
    }
  });
});

const SCENES = [
  { scene: 'codex-link', host: '[data-codex-login-callback]', kind: 'address', form: 'textarea' },
  { scene: 'claude-code', host: '[data-claude-login-code]', kind: 'code', form: 'textarea' },
] as const;

/** The step text of a waiting sign-in, without the link, the field and the buttons: what a person has to READ. */
const readableWords = (selector: string): number => {
  const host = document.querySelector<HTMLElement>(selector);
  if (host === null) return -1;
  const clone = host.cloneNode(true) as HTMLElement;
  for (const drop of clone.querySelectorAll('code, textarea, button, form, [data-sign-in-demo], figure')) drop.remove();
  return clone.innerText.split(/\s+/u).filter(Boolean).length;
};

/** Every animation inside the demo, paused and set to `ms` of its timeline (delays included), then what is on show. */
const atTime = async (tab: Page, ms: number) =>
  await tab.evaluate(time => {
    const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
    const animations = document.getAnimations().filter(a => demo.contains((a.effect as KeyframeEffect).target));
    for (const a of animations) {
      a.pause();
      a.currentTime = time;
    }
    const frames = [...demo.querySelectorAll<HTMLElement>('[data-frame]')];
    const field = demo.querySelector('.fy-sd__field') as HTMLElement;
    const typed = demo.querySelector('.fy-sd__typed') as HTMLElement;
    return {
      shown: frames.filter(frame => Number(getComputedStyle(frame).opacity) > 0.9).map(frame => frame.dataset['frame']),
      typed: typed.getBoundingClientRect().width / Math.max(1, field.getBoundingClientRect().width - 18),
    };
  }, ms);

describe('a waiting sign-in shows what to do instead of explaining it', () => {
  for (const { scene, host, kind } of SCENES) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        it(`${scene}: four frames, once; the picture is before the paste field (${viewport.name}, ${theme})`, async () => {
          const { tab, problems, close } = await open(viewport, theme, scene);
          try {
            await tab.locator(`${host} [data-sign-in-demo="${kind}"]`).waitFor({ state: 'visible' });
            const layout = await tab.evaluate(
              ({ hostSelector }) => {
                const hostEl = document.querySelector(hostSelector) as HTMLElement;
                const demo = hostEl.querySelector('[data-sign-in-demo]') as HTMLElement;
                const steps = hostEl.querySelector('[data-sign-in-steps]') as HTMLElement;
                const form = hostEl.querySelector('form') as HTMLElement;
                const d = demo.getBoundingClientRect();
                const s = steps.getBoundingClientRect();
                const f = form.getBoundingClientRect();
                return {
                  demoLeft: d.left,
                  demoTop: d.top,
                  demoBottom: d.bottom,
                  demoWidth: d.width,
                  demoHeight: d.height,
                  stepsRight: s.right,
                  stepsTop: s.top,
                  stepsBottom: s.bottom,
                  formTop: f.top,
                  scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                  viewport: window.innerWidth,
                  viewportHeight: window.innerHeight,
                };
              },
              { hostSelector: host },
            );
            measured[`${scene}-${viewport.name}-${theme}`] = layout;
            if (viewport.phone) {
              // Stacked, and the picture sits BETWEEN the steps and the paste field, on screen with the instruction.
              expect(layout.demoTop).toBeGreaterThanOrEqual(layout.stepsBottom - 1);
              expect(layout.demoBottom).toBeLessThanOrEqual(layout.formTop + 1);
              expect(layout.demoBottom).toBeLessThanOrEqual(layout.viewportHeight);
              expect(layout.demoWidth).toBeLessThanOrEqual(layout.viewport - 32);
            } else {
              expect(layout.demoLeft).toBeGreaterThan(layout.stepsRight + 8);
              expect(Math.abs(layout.demoTop - layout.stepsTop)).toBeLessThanOrEqual(4);
            }
            expect(layout.demoHeight).toBeGreaterThan(100);
            expect(layout.scrollX).toBeLessThanOrEqual(0);

            // Four frames exist; each caption is at most eight words; every animation runs ONCE.
            const frames = await tab.evaluate(() => {
              const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
              const animations = document
                .getAnimations()
                .filter(a => demo.contains((a.effect as KeyframeEffect).target));
              return {
                captions: [...demo.querySelectorAll('figcaption')].map(c => c.textContent ?? ''),
                iterations: animations.map(a => (a.effect as KeyframeEffect).getComputedTiming().iterations),
                signInStep: demo.querySelector('[data-frame="2"] [data-sign-in-step]') !== null,
                address: demo.querySelector('[data-frame="3"] .fy-sd__address[data-hot]')?.textContent ?? null,
                codeHot: demo.querySelector('[data-frame="3"] .fy-sd__code[data-hot]') !== null,
                hotFill: (() => {
                  const hot = demo.querySelector('[data-frame="3"] .fy-sd__address') as HTMLElement;
                  const plain = demo.querySelector('[data-frame="1"] .fy-sd__address') as HTMLElement;
                  return [getComputedStyle(hot).backgroundColor, getComputedStyle(plain).backgroundColor];
                })(),
              };
            });
            measured[`${scene}-${viewport.name}-${theme}-frames`] = frames;
            expect(frames.captions).toHaveLength(4);
            for (const caption of frames.captions) expect(caption.split(/\s+/u).length).toBeLessThanOrEqual(8);
            expect(frames.iterations.length).toBeGreaterThanOrEqual(5);
            expect(frames.iterations.every(count => count === 1)).toBe(true);
            expect(frames.signInStep).toBe(true);
            if (kind === 'address') {
              expect(frames.address).toBe('http://localhost…');
              expect(frames.hotFill[0]).not.toBe(frames.hotFill[1]);
            } else expect(frames.codeHot).toBe(true);

            // The frames take turns, in order, and the last stays: 1.5 s, 4.5 s, 7.5 s, 10.5 s, then the end state.
            const turns = [
              await atTime(tab, 1_500),
              await atTime(tab, 4_500),
              await atTime(tab, 7_500),
              await atTime(tab, 10_500),
            ];
            const early = await atTime(tab, 9_400);
            const end = await atTime(tab, 20_000);
            measured[`${scene}-${viewport.name}-${theme}-turns`] = { turns, early, end };
            expect(turns.map(turn => turn.shown)).toEqual([['1'], ['2'], ['3'], ['4']]);
            expect(early.typed).toBeLessThan(0.1);
            expect(end.shown).toEqual(['4']);
            expect(end.typed).toBeGreaterThan(0.9);

            // Few words: the steps a person reads (not the link, field or buttons).
            const words = await tab.evaluate(readableWords, host);
            measured[`${scene}-${viewport.name}-${theme}-words`] = words;
            expect(words).toBeGreaterThan(0);
            expect(words).toBeLessThanOrEqual(kind === 'address' ? 40 : 28);
            // Shots: mid-animation (the address bar frame) and the final state.
            await atTime(tab, 7_500);
            await shot(tab, viewport, theme, `${scene}-mid`);
            await atTime(tab, 20_000);
            await shot(tab, viewport, theme, `${scene}-final`);
            expect(problems).toEqual([]);
          } finally {
            await close();
          }
        });
      }
    }
  }

  it('left alone, the animation plays once and stays on its last frame (real time)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', 'codex-link');
    try {
      await tab.locator('[data-sign-in-demo]').waitFor({ state: 'visible' });
      const started = Date.now();
      await tab.waitForFunction(
        () => {
          const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
          const animations = document.getAnimations().filter(a => demo.contains((a.effect as KeyframeEffect).target));
          return animations.length > 0 && animations.every(a => a.playState === 'finished');
        },
        undefined,
        { timeout: 20_000 },
      );
      measured['real-time-finished-ms'] = Date.now() - started;
      const end = await tab.evaluate(() => {
        const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
        return [...demo.querySelectorAll<HTMLElement>('[data-frame]')].map(frame =>
          Number(getComputedStyle(frame).opacity),
        );
      });
      expect(end).toEqual([0, 0, 0, 1]);
      // A second later nothing has restarted.
      await tab.waitForTimeout(1_000);
      expect(await tab.evaluate(() => document.getAnimations().some(a => a.playState === 'running'))).toBe(false);
    } finally {
      await close();
    }
  });

  for (const { scene, host, kind } of SCENES) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        it(`${scene}: under reduced motion the four frames are four stills and nothing moves (${viewport.name}, ${theme})`, async () => {
          const { tab, close } = await open(viewport, theme, scene, 'reduce');
          try {
            await tab.locator(`${host} [data-sign-in-demo="${kind}"]`).waitFor({ state: 'visible' });
            const facts = await tab.evaluate(() => {
              const demo = document.querySelector('[data-sign-in-demo]') as HTMLElement;
              const frames = [...demo.querySelectorAll<HTMLElement>('[data-frame]')].map(frame => {
                const box = frame.getBoundingClientRect();
                return { left: box.left, top: box.top, opacity: Number(getComputedStyle(frame).opacity) };
              });
              const field = demo.querySelector('.fy-sd__field') as HTMLElement;
              const typed = demo.querySelector('.fy-sd__typed') as HTMLElement;
              return {
                frames,
                running: document
                  .getAnimations()
                  .filter(a => demo.contains((a.effect as KeyframeEffect).target))
                  .filter(a => a instanceof CSSAnimation)
                  .map(a => (a as CSSAnimation).animationName),
                typed: typed.getBoundingClientRect().width / Math.max(1, field.getBoundingClientRect().width - 18),
                scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              };
            });
            measured[`${scene}-${viewport.name}-${theme}-reduced`] = facts;
            expect(facts.running).toEqual([]);
            expect(facts.frames).toHaveLength(4);
            expect(facts.frames.map(frame => frame.opacity)).toEqual([1, 1, 1, 1]);
            // Two by two: two rows, the second row below the first, columns left to right.
            expect(new Set(facts.frames.map(frame => Math.round(frame.top))).size).toBe(2);
            expect(facts.frames[0]!.left).toBeLessThan(facts.frames[1]!.left);
            expect(facts.frames[2]!.top).toBeGreaterThan(facts.frames[0]!.top);
            expect(facts.typed).toBeGreaterThan(0.9);
            expect(facts.scrollX).toBeLessThanOrEqual(0);
            await shot(tab, viewport, theme, `${scene}-reduced`);
          } finally {
            await close();
          }
        });
      }
    }
  }
});
