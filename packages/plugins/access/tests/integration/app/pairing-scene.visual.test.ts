/**
 * THE PAIR PAGE'S MASCOT AND NIGHT SKY in a real browser over fake data (`fixtures/pairing-scene.tsx`): the real
 * `PairingScreen` on the relay path (machine name + "through the relay", fingerprint behind Details, no `127.0.0.1`).
 *
 *  - ONE primary action, "Pair this device", and the "Name this device" control, with the mascot and the sky around them;
 *  - the sky is there and moving (twinkle, shooting star) — and STILL under reduced motion, whether the OS asks for it
 *    or the app's Motion = Reduced does: no animation is running, and the final picture is whole;
 *  - the Fleet Grid breathes: its opacity differs between the rest and the peak of the breath, and it is a still, whole
 *    grid under reduced motion;
 *  - a hidden tab pauses every sky animation;
 *  - success: "Connected" takes focus, the mascot cheers, one streak crosses the sky, and the sky's stars brighten;
 *  - text on the sky keeps >= 4.5:1: muted text on the page background, and the halo that erases a star behind a glyph.
 *
 * Set `FY_PAIRING_SCENE_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png` (phone 390 and desktop 1280, light and dark):
 * `pair`, `details`, `success-f1..f3` (the success motion at 0.25 s, 0.7 s and 1.5 s), `success` (settled), `success-reduced`,
 * and `offer` / `offer-reduced`: the success screen WITH "Add a passkey now" (first window open, 7 minutes left).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { expectDetailsOnFinalLine } from './details-on-final-line.ts';

setDefaultTimeout(60_000);

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PAIRING_SCENE_SHOTS_DIR ?? '';
/** `FY_PAIRING_SCENE_SCALE=2` keeps the desktop shots at 2x too (a phone is always 2x), so a picture holds up when zoomed. */
const desktopScale = Number(process.env.FY_PAIRING_SCENE_SCALE ?? '1') || 1;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pairing-scene-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pairing-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pairing scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: 'desktop-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: 'desktop-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, query = '', reducedMotion: 'reduce' | 'no-preference' = 'no-preference') => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : desktopScale,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
    reducedMotion,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector('[data-pairing-stage]');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

/** The CSS animations that are running now (the page's own colour transitions at load are not the sky or the mascot). */
const runningAnimations = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    document
      .getAnimations()
      .filter(animation => animation.playState === 'running' && animation instanceof CSSAnimation)
      .map(animation => (animation as CSSAnimation).animationName),
  );

const seek = async (tab: Page, at: number): Promise<void> =>
  await tab.evaluate(time => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = time;
    }
  }, at);

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const pair = async (tab: Page): Promise<void> => {
  await tab.getByRole('button', { name: 'Pair this device' }).click();
  await tab.waitForSelector('[data-pairing-stage="paired"]');
};

/** `rgb(...)`, `rgba(...)` or `color(srgb r g b [/ a])`, as 0-255 channels. */
const channels = (css: string): [number, number, number] => {
  const numbers = (css.match(/-?\d*\.?\d+/gu) ?? []).map(Number);
  const [r = 0, g = 0, b = 0] = numbers;
  return css.startsWith('color(') ? [r * 255, g * 255, b * 255] : [r, g, b];
};
const luminance = ([r, g, b]: [number, number, number]): number => {
  const lin = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('The pair page: mascot and night sky', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: on the daemon's own machine the line is the direct one with its address, Details on its final line`, async () => {
      const { tab, close } = await open(variant, '&same=1');
      try {
        expect(await tab.locator('[data-daemon-path]').innerText()).toBe(
          'Pairing directly with 127.0.0.1:7617. Details',
        );
        expect(await tab.locator('[data-daemon-path]').getAttribute('data-daemon-path')).toBe('direct');
        await expectDetailsOnFinalLine(tab, '[data-daemon-path]', 'the same-machine confirm line');
        await shot(tab, variant, 'pair-same-machine');
      } finally {
        await close();
      }
    });

    it(`${variant.name}: one primary action, the name control, the mascot peeking, a living sky, no loopback address`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        expect(await tab.locator('[data-variant="primary"]').count(), 'one primary action').toBe(1);
        expect(await tab.getByRole('button', { name: 'Pair this device' }).count()).toBe(1);
        expect(await tab.locator('[data-pair-device-rename]').count(), 'the name control is kept').toBe(1);
        expect(await tab.locator('svg.fy-ferret[data-pose="peek"]').count()).toBe(1);
        expect(await tab.locator('[data-sky]').count()).toBe(1);
        expect(
          await tab.locator('[data-sky] .fy-sky-star').count(),
          'a dozen-odd twinkling stars, not hundreds',
        ).toBeLessThan(20);
        expect(await tab.locator('body').innerText()).not.toContain('127.0.0.1');
        // The sky and the mascot are scenery: out of the accessibility tree and out of the tab order.
        expect(await tab.locator('[data-sky]').getAttribute('aria-hidden')).toBe('true');
        expect(await tab.locator('svg.fy-ferret').getAttribute('aria-hidden')).toBe('true');
        const names = await tab.evaluate(() => document.getAnimations().map(a => (a as CSSAnimation).animationName));
        expect(names.includes('fy-sky-twinkle'), 'the stars twinkle').toBe(true);
        expect(names.includes('fy-sky-shoot'), 'the shooting stars are scheduled').toBe(true);
        expect(names.includes('fy-sky-breathe'), 'the grid breathes').toBe(true);
        // Only transform and opacity ever animate, so nothing here re-lays-out or repaints a phone.
        const properties = await tab.evaluate(() => {
          const found = new Set<string>();
          for (const animation of document.getAnimations()) {
            if (!(animation instanceof CSSAnimation)) continue;
            for (const frame of (animation.effect as KeyframeEffect).getKeyframes())
              for (const key of Object.keys(frame)) found.add(key);
          }
          return [...found].filter(key => !['offset', 'easing', 'composite', 'computedOffset'].includes(key)).sort();
        });
        expect(properties.filter(key => !['opacity', 'transform'].includes(key))).toEqual([]);
        // C59 O8-1: the machine is ONE line with a small "Details" link on its end, not a card (no panel, one row tall).
        expect(await tab.locator('main .kt-panel').count(), 'no card for the machine').toBe(0);
        // Measured against the FINAL TEXT LINE, not the paragraph: Details wrapped onto a line of its own is still inside the paragraph.
        await expectDetailsOnFinalLine(tab, '[data-daemon-path]', 'the pair confirm line');
        // C59 O8-2: one left-aligned column on a desktop (the heading starts where the buttons start); centred on a phone.
        const column = must(await tab.locator('main').boundingBox(), 'the column');
        const notNowBox = must(await tab.getByRole('button', { name: 'Not now' }).boundingBox(), 'Not now');
        const titleBox = await tab.locator('#pairing-title').evaluate(node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect().x;
        });
        if (variant.phone) expect(titleBox, 'phone: the heading is centred').toBeGreaterThan(notNowBox.x + 24);
        else {
          // One reading width per page type: the column is capped by the step frame's `--fy-reading-w` token, not a literal.
          const readingWidth = await tab.evaluate(() =>
            Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fy-reading-w')),
          );
          expect(readingWidth, 'the step frame defines --fy-reading-w').toBeGreaterThan(0);
          expect(column.width, 'desktop: a reading column').toBeLessThanOrEqual(readingWidth);
          // C59 O8-2: the two answers are ONE group at the column's right edge (Not now beside Pair this device), under a
          // heading and a field that start at the column's left edge: no answer on each edge of the page.
          const pairBox = must(await tab.getByRole('button', { name: 'Pair this device' }).boundingBox(), 'Pair');
          const field = must(await tab.locator('main input').first().boundingBox(), 'the name field');
          expect(Math.abs(titleBox - field.x), 'desktop: heading and field share the left edge').toBeLessThanOrEqual(2);
          expect(
            Math.abs(pairBox.x + pairBox.width - (field.x + field.width)),
            'desktop: Pair this device ends at the column right edge',
          ).toBeLessThanOrEqual(1);
          expect(
            pairBox.x - (notNowBox.x + notNowBox.width),
            'desktop: Not now sits right beside it, one 12px gap',
          ).toBeCloseTo(12, 0);
        }
        // Another device is not "this computer": the relayed line names the target and how it is reached, word for word.
        expect(await tab.locator('[data-daemon-path]').innerText()).toBe(
          'Connecting to the machine through the relay. Details',
        );
        await shot(tab, variant, 'pair');
        await tab.locator('[data-pair-details] button', { hasText: 'Details' }).click();
        await shot(tab, variant, 'details');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: success cheers, takes focus, streaks the sky once and brightens the stars`, async () => {
      const { tab, close } = await open(variant);
      try {
        await pair(tab);
        expect(await tab.locator('svg.fy-ferret').getAttribute('data-pose')).toBe('cheer');
        expect(await tab.evaluate(() => document.activeElement?.id)).toBe('pairing-title');
        expect(await tab.locator('#pairing-title').innerText()).toBe('Connected');
        expect(await tab.locator('[data-sky][data-celebrating] .fy-sky-streak').count()).toBe(1);
        expect(await tab.locator('main').innerText()).toContain('Paired with kirin-workstation.');
        // C59 O3: how it connected is a detail behind a tap, not in the main words.
        expect(await tab.locator('.fy-pair-arrive').innerText()).not.toContain('through the relay');
        expect(await tab.locator('body').innerText()).not.toContain('127.0.0.1');
        // One live region the whole way through, so the arrival is announced.
        expect(await tab.locator('[role="status"]').count()).toBe(1);
        expect(await tab.locator('[role="status"]').innerText()).toBe(
          'Connected. Paired with kirin-workstation, through the relay.',
        );
        for (const [name, at] of [
          ['success-f1', 250],
          ['success-f2', 700],
          ['success-f3', 1_500],
        ] as const) {
          await seek(tab, at);
          await shot(tab, variant, name);
        }
        await seek(tab, 4_000);
        await shot(tab, variant, 'success');
      } finally {
        await close();
      }
    });

    it(`${variant.name}: under reduced motion (OS or app) the sky is still and the final picture is whole`, async () => {
      for (const how of ['os', 'app'] as const) {
        const { tab, close } = await open(
          variant,
          how === 'app' ? '&motion=reduced' : '',
          how === 'os' ? 'reduce' : 'no-preference',
        );
        try {
          // The blink is the one animation reduced motion keeps (r11 O10; the sky and every pose animation are still).
          const stilled = async () => (await runningAnimations(tab)).filter(name => name !== 'fy-ferret-blink');
          expect(await stilled(), `${how}: before pairing`).toEqual([]);
          await pair(tab);
          // The streak element exists, but nothing runs: no animation, and the picture is the finished one.
          expect(await stilled(), `${how}: after pairing`).toEqual([]);
          expect(await tab.locator('svg.fy-ferret').getAttribute('data-pose')).toBe('cheer');
          // Reduced motion does not remove transitions, it shortens them to ~1 ms (the app's own reduced-motion block),
          // so the arm's opacity change from 0 to 1 is still a running CSSTransition for a frame or two after the pose
          // flips, and reading it at once under load sees the first value, "0". Let those finish, then read the picture.
          const arm = await tab.evaluate(async () => {
            await Promise.all(
              document
                .getAnimations()
                .filter(animation => animation instanceof CSSTransition)
                .map(animation => animation.finished),
            );
            return getComputedStyle(document.querySelector('.fy-ferret-wave') as Element).opacity;
          });
          expect(arm, `${how}: the waving arm is out in the still picture`).toBe('1');
          if (how === 'os') await shot(tab, variant, 'success-reduced');
        } finally {
          await close();
        }
      }
    });
  }

  for (const variant of VARIANTS) {
    it(`${variant.name}: the machine name typed on the confirm screen is sent, shown on Connected and on both first-passkey labels`, async () => {
      const { tab, problems, close } = await open(variant, '&offer=open');
      try {
        // Typed for real: the name field, not a query flag, and the device name left as the page proposes it.
        await tab.locator('[data-pair-machine-name]').fill('Studio box');
        await pair(tab);
        expect(await tab.locator('.fy-pair-arrive').innerText()).toContain('Paired with Studio box.');
        expect(await tab.locator('main').innerText()).not.toContain('kirin-workstation');
        const scene = () =>
          tab.evaluate(
            () =>
              (
                window as unknown as {
                  __pairScene: { sent: { deviceName: string; machineName?: string }[]; created: unknown[] };
                }
              ).__pairScene,
          );
        expect((await scene()).sent.map(sent => sent.machineName)).toEqual(['Studio box']);
        await tab.waitForSelector('[data-first-passkey-offer]');
        await tab.getByRole('button', { name: 'Add a passkey now' }).click();
        await tab.waitForFunction(
          () => (window as unknown as { __pairScene: { created: unknown[] } }).__pairScene.created.length > 0,
        );
        const [created] = (await scene()).created as { user: { name: string; displayName: string } }[];
        expect(created?.user.name).toBe('Chrome on Linux · 4f2a → Studio box');
        expect(created?.user.displayName).toBe('Ferretry: Chrome on Linux · 4f2a → Studio box');
        expect(`${created?.user.name}${created?.user.displayName}`).not.toContain('kirin-workstation');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: with no name typed, Connected and the labels fall back to the host name`, async () => {
      const { tab, close } = await open(variant, '&offer=open');
      try {
        await pair(tab);
        expect(await tab.locator('.fy-pair-arrive').innerText()).toContain('Paired with kirin-workstation.');
        const sent = await tab.evaluate(
          () => (window as unknown as { __pairScene: { sent: object[] } }).__pairScene.sent,
        );
        expect(sent).toEqual([{ deviceName: 'Chrome on Linux · 4f2a' }]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: the success screen offers "Add a passkey now" with why, what happens after and no bare countdown, one clear way on, readable on the sky`, async () => {
      for (const how of ['normal', 'reduced'] as const) {
        const { tab, problems, close } = await open(
          variant,
          '&offer=open',
          how === 'reduced' ? 'reduce' : 'no-preference',
        );
        try {
          await pair(tab);
          await tab.waitForSelector('[data-first-passkey-offer]');
          const offer = tab.locator('[data-first-passkey-offer]');
          const words = await offer.innerText();
          // C59 O3: WHY a passkey, what happens after the quick window, and no bare "N minutes left".
          expect(words).toContain('approve risky actions with your fingerprint or face');
          expect(words).toContain('about 7 minutes');
          expect(words).toContain('later in Settings');
          expect(words).not.toContain('minutes left');
          expect(words).not.toContain('through the relay');
          expect(await tab.getByRole('button', { name: 'Add a passkey now' }).isVisible()).toBe(true);
          // ONE primary action: the passkey. "Not now" is the quiet way on; nothing else asks for a press.
          // The DOM follows the picture (Tab too): the way on first on a phone, where it is on top; the way out first on a desktop.
          expect(await tab.locator('main button:visible:not([data-pair-details] button)').allInnerTexts()).toEqual(
            variant.phone ? ['Add a passkey now', 'Not now'] : ['Not now', 'Add a passkey now'],
          );
          expect(await tab.locator('[data-variant="primary"]').allInnerTexts()).toEqual(['Add a passkey now']);
          expect(await tab.locator('#pairing-title').innerText()).toBe('Connected');
          // C59 O3: the shared answer row. Each answer is at least 44 px tall; on a phone both are the card's width and stacked;
          // on a desktop Not now and Add a passkey now are one group at the right end of one row.
          const add = must(await tab.getByRole('button', { name: 'Add a passkey now' }).boundingBox(), 'add');
          const later = must(await tab.getByRole('button', { name: 'Not now' }).boundingBox(), 'later');
          for (const box of [add, later]) expect(box.height, 'at least 44 px tall').toBeGreaterThanOrEqual(43.5);
          // Q6 (ruling C-6): content-sized with a 12rem minimum; on a desktop the two share the minimum, on a phone neither is the card's width.
          expect(add.width, 'Add a passkey now keeps the minimum').toBeGreaterThanOrEqual(191);
          expect(later.width, 'Not now keeps the minimum').toBeGreaterThanOrEqual(191);
          if (!variant.phone) expect(Math.abs(add.width - later.width), 'same size').toBeLessThanOrEqual(1);
          const row = must(await offer.boundingBox(), 'offer');
          // C59 O8-3: the dimmed hint is clearly apart from the buttons (not one 12px gap, the same as between its own lines).
          const hint = must(await tab.locator('[data-first-passkey-when]').boundingBox(), 'the hint');
          const firstButton = variant.phone ? add : later;
          expect(
            firstButton.y - (hint.y + hint.height),
            'a clear gap between the hint and the buttons',
          ).toBeGreaterThanOrEqual(20);
          if (variant.phone) {
            expect(add.width, 'phone: content-sized, not the card width (Q6)').toBeLessThan(row.width - 40);
            expect(add.y, 'phone: stacked, the way on above').toBeLessThan(later.y);
          } else {
            expect(Math.abs(add.y - later.y), 'desktop: one row').toBeLessThanOrEqual(1);
            expect(later.x - row.x, 'Not now is beside Add, not at the far left end').toBeGreaterThan(40);
            expect(add.x - (later.x + later.width), 'Not now sits right beside Add (one 12px gap)').toBeCloseTo(12, 0);
            expect(
              Math.abs(add.x + add.width - (row.x + row.width)),
              'Add a passkey now at the right end',
            ).toBeLessThanOrEqual(1);
          }
          // "Not now" is a real secondary button (a visible border, not the borderless ghost that reads as bare text).
          const notNow = await tab.getByRole('button', { name: 'Not now' }).evaluate(node => ({
            variant: node.getAttribute('data-variant'),
            border: Number.parseFloat(getComputedStyle(node).borderTopWidth),
          }));
          expect(notNow.variant, 'Not now is not a ghost button').not.toBe('ghost');
          expect(notNow.border, 'Not now has a border like a button').toBeGreaterThan(0);
          // The offer draws its own surface, so it carries no sky halo around its words.
          expect(await offer.evaluate(node => getComputedStyle(node).textShadow)).toBe('none');
          // It sits inside the viewport on a phone: no horizontal scroll.
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (how === 'normal') await seek(tab, 4_000);
          await shot(tab, variant, how === 'reduced' ? 'offer-reduced' : 'offer');
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      }
    });
  }

  // G2: the pairing page draws no shell chrome, so it has its own Back; and its buttons are auto width, 44px tall.
  for (const variant of VARIANTS) {
    it(`${variant.name}: has a 44px Back, and the confirm and paste buttons are auto width and 44px tall`, async () => {
      const { tab, problems, close } = await open(variant, '&back=1');
      try {
        const back = must(await tab.locator('[data-pairing-close]').boundingBox(), 'Back');
        expect(back.height, 'Back is at least 44 px tall').toBeGreaterThanOrEqual(44);
        const confirm = must(await tab.locator('[data-pair-confirm]').boundingBox(), 'Pair this device');
        expect(confirm.height, 'at least 44 px tall').toBeGreaterThanOrEqual(43.5);
        // C59 O2: the answers are the shared row (phone: the card's width, stacked; desktop: 12 rem each at the two ends); the
        // balance test (pair-confirm-balance.visual.test.ts) owns that geometry.
        // r11-1b G4: every button on the page is at least O2's 136 px (8.5rem), Back included (it was 51 px).
        expect(back.width, 'Back is at least 136 px wide').toBeGreaterThanOrEqual(135.5);
        expect(confirm.width, 'Pair this device is at least 136 px wide').toBeGreaterThanOrEqual(135.5);
        // C59 O2: Rename is text on the "called" line now (balance test), not a button.
        for (const selector of ['button:text-is("Not now")']) {
          const box = must(await tab.locator(selector).boundingBox(), selector);
          expect(box.width, `${selector} is at least 136 px wide`).toBeGreaterThanOrEqual(135.5);
          expect(box.height, `${selector} is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
        }
        await shot(tab, variant, 'back-confirm');
        await tab.locator('[data-pairing-close]').click();
        expect(await tab.evaluate(() => document.documentElement.hasAttribute('data-went-back'))).toBe(true);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  for (const variant of VARIANTS) {
    it(`${variant.name}: a cold open offers scan, upload and paste as three equal cards, none a full-width bar`, async () => {
      const { tab, problems, close } = await open(variant, '&arrival=cold&scan=camera&back=1');
      try {
        const ways = tab.locator('[data-pair-ways] label');
        expect(await ways.allInnerTexts()).toEqual(['Scan QR code', 'Upload a QR image', 'Paste a link']);
        const boxes = await Promise.all(
          [0, 1, 2].map(async index => must(await ways.nth(index).boundingBox(), 'a way')),
        );
        for (const box of boxes) expect(box.height, 'at least 44 px tall').toBeGreaterThanOrEqual(44);
        expect(new Set(boxes.map(box => Math.round(box.width))).size, 'equal widths').toBe(1);
        // The app's choice cards: a row where there is room, a stack where there is not (a phone).
        const rows = new Set(boxes.map(box => Math.round(box.y))).size;
        expect(rows, variant.phone ? 'stacked' : 'one row').toBe(variant.phone ? 3 : 1);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await shot(tab, variant, 'ways');
        await ways.nth(2).click();
        await tab.waitForSelector('input[aria-label="Pairing link"]');
        const submit = must(await tab.getByRole('button', { name: 'Use this link' }).boundingBox(), 'the submit');
        // C59 audit: the shared answer row: the field's width on a phone, a 12 rem button at the right end on a desktop.
        if (variant.phone) {
          const field = must(await tab.locator('input[aria-label="Pairing link"]').boundingBox(), 'the field');
          // Q6 (ruling C-6): content-sized (12rem minimum), NOT the field's full width, on a phone too.
          expect(submit.width, 'phone: Use this link is narrower than the field').toBeLessThan(field.width - 40);
        } else expect(submit.width, 'the submit is not a full-width bar').toBeLessThan(variant.width * 0.6);
        expect(submit.width, 'r11-1b G4: Use this link is at least 136 px wide').toBeGreaterThanOrEqual(135.5);
        // The paste path is mounted WITH a return path, so Back is on it: exactly one, 136 px wide and 44 tall.
        expect(await tab.locator('[data-pairing-close]').count(), 'the paste path has exactly one Back').toBe(1);
        const pasteBack = must(await tab.locator('[data-pairing-close]').boundingBox(), 'Back on the paste path');
        expect(pasteBack.width, 'Back on the paste path is at least 136 px wide').toBeGreaterThanOrEqual(135.5);
        expect(pasteBack.height, 'Back on the paste path is at least 44 px tall').toBeGreaterThanOrEqual(43.5);
        await shot(tab, variant, 'ways-paste');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  it('the Fleet Grid breathes: rest and peak differ, the stars stay, and a still grid is whole', async () => {
    for (const variant of VARIANTS) {
      const { tab, close } = await open(variant);
      try {
        const grid = tab.locator('.fy-sky-grid');
        expect(await grid.count()).toBe(1);
        const read = async (at: number) => {
          await seek(tab, at);
          return await grid.evaluate(node => {
            const style = getComputedStyle(node);
            return { opacity: Number(style.opacity), transform: style.transform };
          });
        };
        const rest = await read(0);
        const peak = await read(3_500);
        expect(peak.opacity, 'the grid is brighter at the peak of its breath').toBeGreaterThan(rest.opacity);
        expect(peak.transform, 'and a hair larger').not.toBe(rest.transform);
        // Subtle: it never goes dark and never gets loud over the card's text.
        expect(rest.opacity).toBeGreaterThan(0.02);
        expect(peak.opacity).toBeLessThan(0.13);
        await seek(tab, 0);
        await shot(tab, variant, 'grid-rest');
        await seek(tab, 3_500);
        await shot(tab, variant, 'grid-peak');
        // On success the grid swells a little more, like the stars.
        await tab.evaluate(() => {
          for (const animation of document.getAnimations()) animation.cancel();
        });
        const peakNormal = await grid.evaluate(node =>
          getComputedStyle(node).getPropertyValue('--fy-grid-peak').trim(),
        );
        await pair(tab);
        const peakCelebrating = await grid.evaluate(node =>
          getComputedStyle(node).getPropertyValue('--fy-grid-peak').trim(),
        );
        expect(Number(peakCelebrating)).toBeGreaterThan(Number(peakNormal));
        // The twinkling stars are still there beside it.
        expect(await tab.locator('[data-sky] .fy-sky-star').count()).toBeGreaterThan(8);
      } finally {
        await close();
      }
    }
    for (const how of ['os', 'app'] as const) {
      const { tab, close } = await open(
        VARIANTS[0],
        how === 'app' ? '&motion=reduced' : '',
        how === 'os' ? 'reduce' : 'no-preference',
      );
      try {
        const still = await tab.locator('.fy-sky-grid').evaluate(node => ({
          animation: getComputedStyle(node).animationName,
          opacity: getComputedStyle(node).opacity,
        }));
        expect(still.animation, `${how}: no breathing`).toBe('none');
        expect(Number(still.opacity), `${how}: the still grid is the resting texture`).toBeCloseTo(0.07, 2);
      } finally {
        await close();
      }
    }
  });

  it('a hidden tab pauses every animation, and a visible one resumes them', async () => {
    const { tab, close } = await open(VARIANTS[2]);
    try {
      const setHidden = async (hidden: boolean): Promise<void> =>
        await tab.evaluate(value => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => (value ? 'hidden' : 'visible'),
          });
          document.dispatchEvent(new Event('visibilitychange'));
        }, hidden);
      await setHidden(true);
      await tab.waitForSelector('[data-sky][data-paused]');
      const states = await tab.evaluate(() =>
        [...document.querySelectorAll('[data-sky] *, svg.fy-ferret *')]
          .flatMap(node => node.getAnimations())
          .filter(animation => animation instanceof CSSAnimation)
          .map(animation => animation.playState),
      );
      expect(states.length).toBeGreaterThan(10);
      expect([...new Set(states)]).toEqual(['paused']);
      await setHidden(false);
      await tab.waitForSelector('[data-sky]:not([data-paused])');
      expect((await runningAnimations(tab)).length).toBeGreaterThan(10);
    } finally {
      await close();
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: text on the sky keeps 4.5:1, and the halo behind it is the page background`, async () => {
      const variant = VARIANTS.find(candidate => candidate.scheme === scheme && candidate.phone) as Variant;
      const { tab, close } = await open(variant);
      try {
        const read = await tab.evaluate(() => {
          const probe = (value: string): string => {
            const node = document.createElement('i');
            node.style.color = value;
            document.body.append(node);
            const resolved = getComputedStyle(node).color;
            node.remove();
            return resolved;
          };
          const header = document.querySelector('main header h1') as Element;
          return {
            bg: probe('var(--bg)'),
            fg: getComputedStyle(header).color,
            muted: probe('var(--muted)'),
            halo: getComputedStyle(header).textShadow,
          };
        });
        const bg = channels(read.bg);
        expect(contrast(channels(read.fg), bg), 'heading on the page background').toBeGreaterThanOrEqual(4.5);
        expect(contrast(channels(read.muted), bg), 'muted text on the page background').toBeGreaterThanOrEqual(4.5);
        // Every layer of the halo is the page background colour, so a star behind a letter is erased around it.
        const layers = read.halo.match(/(rgba?\([^)]*\)|color\([^)]*\))/gu) ?? [];
        expect(layers.length).toBeGreaterThanOrEqual(3);
        for (const layer of layers) expect(channels(layer)).toEqual(bg);
      } finally {
        await close();
      }
    });
  }
});
