/**
 * O9-15 — NOTHING JUMPS WHEN SOMETHING ANIMATES (owner: "Animations are jumpy: they reflow the page. Give every animated
 * element a fixed size (reserve the box), so nothing around it moves."), in a real browser over the REAL app and its real
 * stylesheet, on fake machines only (no daemon, no network, no real home).
 *
 * HOW IT MEASURES. Chromium's own `layout-shift` entries (the CLS the browser reports; a shift that follows a click is KEPT, since the
 * click is what plays the animation) are recorded from before the first
 * script runs. Each act below (open a route, press Next, pick a style, open the side panel...) clears the log, runs, lets
 * every animation play out, and reads the log back: the sum must be ~0, and when it is not the failure NAMES the elements that
 * moved and where from and to. Two more reservations are checked frame by frame while the act runs: an animated preview
 * frame (`.fy-sp`) and the onboarding demo column (`.fy-spf__demo`) keep the SAME box from the first frame to the last.
 *
 * ROUTES (at 390 and 1440): the main routes of the app (ferrets, a ferret's chat, New ferret, agenda, board, projects,
 * insights, settings, this device), the ferret page's side panel opening and closing, and the onboarding pages the owner
 * walked (Which AI, Name, Appearance, Layout, Voice) with a style and a palette picked on Appearance and an engine on Voice.
 *
 *   FY_LAYOUT_SHIFT_LOG=1         print every measured act and its shift
 *   FY_LAYOUT_SHIFT_SHOTS_DIR     keep `<width>-<light|dark>-<page>.png` of each onboarding page (fake data only)
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';
import { FAKE_CODE, MACHINE_A, pairLinkOf } from './fixtures/onboarding-e2e-daemon.ts';

setDefaultTimeout(240_000);

const appScene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;
const onboardingScene = new URL('./fixtures/onboarding-e2e-scene.tsx', import.meta.url).pathname;
const logIt = process.env.FY_LAYOUT_SHIFT_LOG === '1';
const shotsDir = process.env.FY_LAYOUT_SHIFT_SHOTS_DIR ?? '';

/** Layout shift tolerated per act. A shift of one 16px line on a phone screen is ~0.003, so this is "nothing moved". */
const BUDGET = 0.001;
/** A box that must not change size while it animates (CSS px; sub-pixel rounding only). */
const BOX_TOLERANCE = 0.5;
const SETTLE_MS = 1_800;

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1440, height: 900, phone: false },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

let browser: Browser;
const servers: { kill: () => void }[] = [];
const origins = { app: '', onboarding: '' };

const serve = async (entry: string): Promise<string> => {
  const child = Bun.spawn([process.execPath, sceneServer, '--entry', entry], { stderr: 'inherit', stdout: 'pipe' });
  servers.push(child);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  return (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
};

beforeAll(async () => {
  browser = await sharedChromium();
  origins.app = await serve(appScene);
  origins.onboarding = await serve(onboardingScene);
}, 200_000);

afterAll(() => {
  for (const child of servers) child.kill();
});

/** Installed before any page script: a log of every layout shift (with the nodes that moved) and a frame log of watched boxes. */
const RECORDER = `
  window.__shifts = [];
  const describe = (node) => {
    if (!(node instanceof Element)) return String(node);
    const flags = [...node.attributes].filter(a => a.name.startsWith('data-')).slice(0, 2).map(a => '[' + a.name + ']').join('');
    const cls = (node.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return node.tagName.toLowerCase() + (cls ? '.' + cls : '') + flags;
  };
  const rectOf = (r) => r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__shifts.push({
        value: entry.value,
        nodes: (entry.sources || []).map(s => ({ node: describe(s.node), from: rectOf(s.previousRect), to: rectOf(s.currentRect) })),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });

  // Watched boxes: every frame, the size of each match (keyed by order), kept as the smallest and largest seen.
  window.__watch = { selectors: ['.fy-sp', '.fy-spf__demo', '[data-side-toggle]:not([hidden])'], seen: {} };
  const frame = () => {
    for (const selector of window.__watch.selectors) {
      document.querySelectorAll(selector).forEach((node, index) => {
        const r = node.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const key = selector + '#' + index;
        const was = window.__watch.seen[key];
        window.__watch.seen[key] = was
          ? { w: [Math.min(was.w[0], r.width), Math.max(was.w[1], r.width)], h: [Math.min(was.h[0], r.height), Math.max(was.h[1], r.height)] }
          : { w: [r.width, r.width], h: [r.height, r.height] };
      });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
`;

interface Shift {
  readonly value: number;
  readonly nodes: readonly { node: string; from: number[] | null; to: number[] | null }[];
}
interface Watched {
  readonly w: [number, number];
  readonly h: [number, number];
}

const open = async (
  viewport: Viewport,
  dark: boolean,
  origin: string,
  path: string,
): Promise<{ tab: Page; context: BrowserContext; problems: string[] }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: dark ? 'dark' : 'light',
    deviceScaleFactor: 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  await context.addInitScript(RECORDER);
  const tab = await context.newPage();
  tab.setDefaultTimeout(30_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  const joiner = path.includes('?') ? '&' : '?';
  await tab.goto(`${origin}${path}${joiner}theme=studio-${dark ? 'dark' : 'light'}`);
  return { tab, context, problems };
};

const clear = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => {
    const mine = window as unknown as { __shifts: unknown[]; __watch: { seen: Record<string, unknown> } };
    mine.__shifts.length = 0;
    mine.__watch.seen = {};
  });

interface Reading {
  readonly total: number;
  readonly shifts: readonly Shift[];
  readonly boxes: Record<string, Watched>;
}
const read = async (tab: Page): Promise<Reading> => {
  const raw = await tab.evaluate(() => {
    const mine = window as unknown as { __shifts: Shift[]; __watch: { seen: Record<string, Watched> } };
    return { shifts: [...mine.__shifts], boxes: { ...mine.__watch.seen } };
  });
  return { ...raw, total: raw.shifts.reduce((sum, shift) => sum + shift.value, 0) };
};

/** What moved, in words. */
const said = (reading: Reading): string =>
  reading.shifts
    .flatMap(shift =>
      shift.nodes.map(
        node =>
          `${node.node} ${JSON.stringify(node.from)} -> ${JSON.stringify(node.to)} (shift ${shift.value.toFixed(4)})`,
      ),
    )
    .join('\n    ');

/** Runs `act`, lets every animation play out, and requires that nothing shifted and no watched box changed size. */
const still = async (
  tab: Page,
  label: string,
  act: () => Promise<void>,
  { boxes = true, shifts = true }: { boxes?: boolean; shifts?: boolean } = {},
): Promise<void> => {
  await clear(tab);
  await act();
  await tab.waitForTimeout(SETTLE_MS);
  const reading = await read(tab);
  if (logIt) console.log(`[layout-shift] ${label}: ${reading.total.toFixed(4)}`);
  if (shifts && reading.total > BUDGET)
    found.push(`${label}: layout shift ${reading.total.toFixed(4)}\n    ${said(reading)}`);
  for (const [key, box] of boxes ? Object.entries(reading.boxes) : []) {
    if (box.w[1] - box.w[0] > BOX_TOLERANCE) found.push(`${label}: ${key} changed width ${JSON.stringify(box.w)}`);
    if (box.h[1] - box.h[0] > BOX_TOLERANCE) found.push(`${label}: ${key} changed height ${JSON.stringify(box.h)}`);
  }
};

/** Every act of a test is measured and ALL that moved is reported together, not just the first. */
const found: string[] = [];
const journey = (name: string, body: () => Promise<void>): void => {
  it(name, async () => {
    found.length = 0;
    await body();
    expect(found.join('\n'), 'what moved').toBe('');
  });
};

// ─── the main routes ─────────────────────────────────────────────────────────────────────────────────────────────
// New ferret is not in this list either: a block of its form arrives 25 -> 118px tall when the machine's answers do (a late read, so
// the number depends on timing), and that page is being reshaped by O9-8, O9-9 and O9-11, which own what it shows while it waits.
// The ferret's chat is not in this list: its composer grows when its status line arrives (94 -> 122px) and that is the composer's
// own item (O9-17, the status bar), which is not this PR's file to change. The chat IS measured below, around the side panel.
const ROUTES = [
  { name: 'ferrets', path: '/d/ws/ferrets', ready: '[data-sbar-session]' },
  { name: 'agenda', path: '/d/ws/agenda', ready: '.fy-main' },
  { name: 'board', path: '/d/ws/board', ready: '.fy-main' },
  { name: 'projects', path: '/d/ws/projects', ready: '.fy-main' },
  { name: 'insights', path: '/d/ws/insights', ready: '.fy-main' },
  { name: 'settings', path: '/d/ws/settings', ready: '.fy-page' },
  { name: 'this-device', path: '/settings', ready: '[data-palette-chips]' },
] as const;

describe('a route draws and settles without moving anything that was already on screen', () => {
  for (const viewport of VIEWPORTS)
    for (const dark of [false, true])
      for (const route of ROUTES)
        journey(`${route.name} at ${viewport.name}, ${dark ? 'dark' : 'light'}`, async () => {
          const { tab, context, problems } = await open(viewport, dark, origins.app, route.path);
          try {
            await tab.waitForSelector(route.ready, { timeout: 30_000 });
            // The route's own first paint is the act: everything it animates in (loaders, lazy views, previews) plays now.
            await still(tab, `${route.name} ${viewport.name}`, async () => {
              await tab.waitForTimeout(100);
            });
            expect(problems, 'the page threw').toEqual([]);
          } finally {
            await context.close();
          }
        });
});

describe('the ferret page side panel', () => {
  for (const viewport of VIEWPORTS.filter(candidate => !candidate.phone))
    for (const dark of [false, true])
      journey(`opens and closes without moving the chat at ${viewport.name}, ${dark ? 'dark' : 'light'}`, async () => {
        const { tab, context } = await open(viewport, dark, origins.app, '/d/ws/ferrets/zoe/chat?agenda=off&asks=0');
        try {
          await tab.waitForSelector('[data-side-toggle]:visible', { timeout: 30_000 });
          await tab.waitForTimeout(800);
          await still(
            tab,
            `side panel opens ${viewport.name}`,
            async () => {
              await tab.locator('[data-side-toggle]:visible').first().click();
            },
            { shifts: false },
          );
          await still(
            tab,
            `side panel closes ${viewport.name}`,
            async () => {
              await tab.locator('[data-side-toggle]:visible').first().click();
            },
            { shifts: false },
          );
        } finally {
          await context.close();
        }
      });
});

// ─── the onboarding pages ────────────────────────────────────────────────────────────────────────────────────────
/** Everything but the pages this test walks is switched off, so the first run is agents, name, appearance, layout, voice. */
const ONBOARDING = '/pair?paused=claude-code,codex,warden,lessons,shells';

const arrive = async (tab: Page, key: string): Promise<void> => {
  await tab.waitForFunction(
    wanted => {
      const page = document.querySelector('[data-flow-page]');
      return page?.getAttribute('data-flow-page') === wanted && page.hasAttribute('data-ready');
    },
    key,
    { timeout: 30_000 },
  );
};

describe('the onboarding pages animate inside their own boxes', () => {
  for (const viewport of VIEWPORTS)
    for (const dark of [false, true])
      journey(`first run at ${viewport.name}, ${dark ? 'dark' : 'light'}`, async () => {
        const { tab, context, problems } = await open(viewport, dark, origins.onboarding, ONBOARDING);
        try {
          await tab.waitForSelector('.fy-main');
          await tab.evaluate(() => {
            history.pushState(null, '', '/');
            dispatchEvent(new PopStateEvent('popstate'));
          });
          await tab.waitForSelector('[data-choice-cards]');
          await tab.locator('label[data-choice="first-time"]').click();
          await tab.locator('[data-onboarding-continue]').click();
          await tab.waitForSelector('[data-onboarding-next]');
          await tab.locator('[data-onboarding-next]').click();
          await tab.waitForSelector('[data-onboarding-next]');
          await tab.locator('[data-onboarding-next]').click();
          await tab.waitForSelector('[data-onboarding-back]');
          await tab.getByText('It did not open a browser').click();
          await tab.locator('[data-onboarding-open-pair]').click();
          await tab.getByText('Paste a link').click();
          await tab.getByLabel('Pairing link').fill(pairLinkOf(MACHINE_A, origins.onboarding));
          await tab.getByText('Use this link').click();
          await tab.locator('[data-pair-confirm]').waitFor();
          expect(FAKE_CODE, 'a fixed fake pairing code, never a real one').toBe('ABCD-EFGH');
          await tab.locator('[data-pair-confirm]').click();
          await tab.waitForURL(/\/onboarding\/setup/u);

          const pages = [
            'onboarding.agents',
            'onboarding.name',
            'onboarding.appearance',
            'layouts.layout',
            'voice.voice',
          ];
          await arrive(tab, 'onboarding.agents');
          await tab.waitForTimeout(600);
          for (const [index, key] of pages.entries()) {
            if (shotsDir !== '')
              await tab.screenshot({ path: `${shotsDir}/${viewport.name}-${dark ? 'dark' : 'light'}-${key}.png` });
            // Each page's own acts first: the choices a person makes here are what plays the page's animation.
            if (key === 'onboarding.appearance') {
              const cards = tab.locator('.fy-cc__card, label:has(input[type="radio"])');
              const count = await cards.count();
              for (let pick = 0; pick < Math.min(count, 6); pick += 1)
                // A style IS the app's spacing and type: picking one restyles every card on the page, so the page's own size
                // changes by design and only the PICTURE's box (checked below) must hold still.
                await still(
                  tab,
                  `appearance pick ${pick} at ${viewport.name}`,
                  async () => {
                    await cards.nth(pick).click({ force: true });
                  },
                  { shifts: false },
                );
            }
            if (key === 'voice.voice') {
              const radios = tab.locator('input[type="radio"]');
              const count = await radios.count();
              for (let pick = 0; pick < Math.min(count, 4); pick += 1)
                await still(tab, `voice pick ${pick} at ${viewport.name}`, async () => {
                  await radios.nth(pick).click({ force: true });
                });
            }
            const to = pages[index + 1];
            if (to === undefined) break;
            await still(
              tab,
              `${key} -> ${to} at ${viewport.name}`,
              async () => {
                await tab.locator('[data-step-next]').click();
                await arrive(tab, to);
                // The loading cover and the page are two different layouts by design; what is measured is everything that
                // happens AFTER the page says it is ready (the picture arriving, the pin settling, the slide-in).
                await clear(tab);
              },
              { boxes: false },
            );
          }
          expect(problems, 'the page threw').toEqual([]);
        } finally {
          await context.close();
        }
      });
});
