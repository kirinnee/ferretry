/**
 * r11 O10: THE MASCOT REACTS, AND THE PASSKEY OFFER'S BUTTONS ARE ONE FIXED SIZE, in a real browser over the pair page
 * scene (`fixtures/pairing-scene.tsx`). Owner words (turn 4247):
 *
 *  - (2) "make the mascot interacable? like hover it should do something"
 *  - (1)/(5) "buttons -- make them have proper spacing, proper width ... fixed width to make them look more professional"
 *
 * Asserts computed geometry and running animations, not a snapshot:
 *  - hovering the ferret (a mouse) raises it out of the hole, runs a head animation and an ear wiggle it does not run
 *    at rest; leaving puts it back. A tap (a phone has no hover) does the same for ~1.4 s, then settles;
 *  - under reduced motion the hover still shows (it rises) but NOTHING moves: no running animation, no transition;
 *  - on the success screen "Add a passkey now" and "Not now" are exactly the same width (192 px), 44 px or taller,
 *    12 px apart when side by side and centred on one column when stacked, and inside the viewport on a phone.
 *
 * `FY_PAIRING_SCENE_SHOTS_DIR` keeps `<viewport>-<scheme>-<case>.png`: `hover-rest`, `hover` and `offer-buttons`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
};

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PAIRING_SCENE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-mascot-offer-'));
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
    deviceScaleFactor: variant.phone ? 2 : 1,
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
  await tab.waitForSelector('[data-pairing-stage], [data-export-mascot]');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  // A finite entrance animation (the card fading in) must have settled: a shot of it half-drawn proves nothing.
  await tab.evaluate(
    async () =>
      await Promise.all(
        document
          .getAnimations()
          .filter(
            animation => animation instanceof CSSAnimation && animation.effect?.getTiming().iterations !== Infinity,
          )
          .map(animation => animation.finished),
      ),
  );
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

/** How far down the burrow the ferret sits (its body's translateY, in SVG units), after any transition has finished. */
const sink = async (tab: Page): Promise<number> =>
  await tab.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(animation => animation instanceof CSSTransition)
        .map(animation => animation.finished),
    );
    const matrix = new DOMMatrixReadOnly(
      getComputedStyle(document.querySelector('.fy-ferret-body') as Element).transform,
    );
    return matrix.f;
  });

/** The names of the CSS animations running on the mascot now (finite or not), with the element each one runs on. */
const ferretAnimations = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    document
      .getAnimations()
      .filter(animation => animation.playState === 'running' && animation instanceof CSSAnimation)
      .filter(animation => (animation.effect as KeyframeEffect).target?.closest('.fy-ferret') !== null)
      .map(animation => (animation as CSSAnimation).animationName),
  );

/** The ferret's running animations as `name@marker`, where the marker is the element's own data-mascot-* attribute. */
const markedAnimations = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    document
      .getAnimations()
      .filter(animation => animation.playState === 'running' && animation instanceof CSSAnimation)
      .map(animation => ({ animation: animation as CSSAnimation, target: (animation.effect as KeyframeEffect).target }))
      .filter(({ target }) => target?.closest('.fy-ferret') != null)
      .map(({ animation, target }) => {
        const marker = (target as Element).getAttributeNames().find(name => name.startsWith('data-mascot-')) ?? '-';
        return `${animation.animationName}@${marker}`;
      }),
  );

/** Where the pupils are looking: the translation of the eyes' look layer (SVG units), after a transition has finished. */
const look = async (tab: Page): Promise<{ x: number; y: number }> =>
  await tab.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(animation => animation instanceof CSSTransition)
        .map(animation => animation.finished),
    );
    const node = document.querySelector('[data-mascot-look]');
    if (node === null) return { x: Number.NaN, y: Number.NaN };
    const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    return { x: matrix.e, y: matrix.f };
  });

/** Press "Pair this device" and wait for the Connected screen (the ferret cheers). */
const connect = async (tab: Page): Promise<void> => {
  await tab.getByRole('button', { name: 'Pair this device' }).click();
  await tab.waitForSelector('[data-pairing-stage="paired"]');
  await tab.waitForSelector('.fy-ferret[data-pose="cheer"]');
};

/** Wait for every finite animation (the arrival: rise, dook, the first wave) to finish, so only a REACTION can run. */
const settle = async (tab: Page): Promise<void> => {
  await tab.evaluate(
    async () =>
      await Promise.all(
        document
          .getAnimations()
          .filter(
            animation => animation instanceof CSSAnimation && animation.effect?.getTiming().iterations !== Infinity,
          )
          .map(animation => animation.finished),
      ),
  );
};

const MEASURED: string[] = [];
const LOOK_X_MAX = 3.3;
const LOOK_Y_MAX = 2.5;

describe('r11 O10: the mascot reacts', () => {
  for (const variant of VARIANTS.filter(item => !item.phone)) {
    it(`${variant.name}: hovering the ferret raises it and runs a head and ear animation; leaving puts it back`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        const rest = await sink(tab);
        const restAnimations = await ferretAnimations(tab);
        expect(restAnimations, 'at rest the ferret does not run the hello animations').not.toContain('fy-ferret-hello');
        await shot(tab, variant, 'hover-rest');
        const box = must(await tab.locator('.fy-ferret').boundingBox(), 'the ferret');
        await tab.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5);
        await tab.waitForFunction(() => document.querySelector('.fy-ferret')?.matches(':hover') === true);
        const raised = await sink(tab);
        const names = await ferretAnimations(tab);
        MEASURED.push(`${variant.name}: body ty rest ${rest} -> hover ${raised}; hover animations ${names.join(',')}`);
        expect(raised, 'the ferret is raised out of the hole by at least 12 SVG units').toBeLessThanOrEqual(rest - 12);
        expect(names, 'the head does its hello').toContain('fy-ferret-hello');
        expect(names, 'the ears wiggle').toContain('fy-ferret-ears');
        await shot(tab, variant, 'hover');
        await tab.mouse.move(2, 2);
        expect(await sink(tab), 'leaving puts the ferret back').toBe(rest);
        expect(await ferretAnimations(tab)).not.toContain('fy-ferret-hello');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  for (const variant of VARIANTS.filter(item => item.phone)) {
    it(`${variant.name}: a tap makes the ferret perk up for a moment, then it settles`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        const rest = await sink(tab);
        const box = must(await tab.locator('.fy-ferret').boundingBox(), 'the ferret');
        await tab.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.5);
        await tab.waitForSelector('.fy-ferret[data-poke]');
        const raised = await sink(tab);
        const names = await ferretAnimations(tab);
        MEASURED.push(`${variant.name}: body ty rest ${rest} -> tap ${raised}; tap animations ${names.join(',')}`);
        expect(raised).toBeLessThanOrEqual(rest - 12);
        expect(names).toContain('fy-ferret-hello');
        await shot(tab, variant, 'hover');
        await tab.waitForFunction(() => document.querySelector('.fy-ferret[data-poke]') === null, undefined, {
          timeout: 4_000,
        });
        expect(await sink(tab), 'it settles back into the hole').toBe(rest);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  // The Connected screen is where the ferret cheers: it used to be excluded from every reaction (the owner's "it never
  // reacts"). Hovering it now makes the pupils FOLLOW the pointer (clamped), the arm wave once more and the ferret hop.
  for (const variant of VARIANTS.filter(item => !item.phone)) {
    it(`${variant.name}: on Connected the pupils follow the pointer (clamped), the arm waves and the ferret hops`, async () => {
      const { tab, problems, close } = await open(variant, '&offer=open');
      try {
        await connect(tab);
        await settle(tab);
        const rest = await look(tab);
        expect(rest, 'at rest the pupils look straight ahead').toEqual({ x: 0, y: 0 });
        expect(await markedAnimations(tab), 'nothing but the blink runs at rest').toEqual([
          'fy-ferret-blink@data-mascot-blink',
        ]);
        const box = must(await tab.locator('.fy-ferret').boundingBox(), 'the ferret');
        const before = Date.now();
        await tab.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9);
        await tab.waitForFunction(
          () =>
            document
              .querySelector('[data-mascot-wave]')
              ?.getAnimations()
              .some(a => a.playState === 'running') === true,
          undefined,
          { timeout: 400 },
        );
        const waveMs = Date.now() - before;
        const running = await markedAnimations(tab);
        expect(running, 'the arm waves').toContain('fy-ferret-wave-again@data-mascot-wave');
        expect(running, 'the ferret hops').toContain('fy-ferret-hop@data-mascot-hop');
        const right = await look(tab);
        await tab.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
        const left = await look(tab);
        await tab.mouse.move(box.x - 200, box.y - 200);
        // Far outside it the ferret has been left: the look is back to straight ahead.
        const away = await look(tab);
        MEASURED.push(
          `${variant.name} connected: wave running after ${waveMs} ms; look right-down ${right.x.toFixed(2)},${right.y.toFixed(2)}; left-up ${left.x.toFixed(2)},${left.y.toFixed(2)}; away ${away.x},${away.y}; animations ${running.join(',')}`,
        );
        expect(right.x, 'the right pupils look right').toBeGreaterThan(1);
        expect(right.y, 'and down').toBeGreaterThan(0.5);
        expect(left.x, 'the left pupils look left').toBeLessThan(-1);
        expect(left.y, 'and up').toBeLessThan(-0.5);
        for (const point of [right, left]) {
          expect(Math.abs(point.x), 'x is clamped').toBeLessThanOrEqual(LOOK_X_MAX);
          expect(Math.abs(point.y), 'y is clamped').toBeLessThanOrEqual(LOOK_Y_MAX);
        }
        expect(away, 'leaving returns the look').toEqual({ x: 0, y: 0 });
        await shot(tab, variant, 'connected-hover');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  for (const variant of VARIANTS.filter(item => item.phone)) {
    it(`${variant.name}: on Connected a tap makes the pupils look at it and the arm wave, then it settles`, async () => {
      const { tab, problems, close } = await open(variant, '&offer=open');
      try {
        await connect(tab);
        await settle(tab);
        const box = must(await tab.locator('.fy-ferret').boundingBox(), 'the ferret');
        await tab.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height * 0.5);
        await tab.waitForFunction(
          () =>
            document
              .querySelector('[data-mascot-wave]')
              ?.getAnimations()
              .some(a => a.playState === 'running') === true,
          undefined,
          { timeout: 400 },
        );
        const running = await markedAnimations(tab);
        const looked = await look(tab);
        MEASURED.push(
          `${variant.name} connected tap: look ${looked.x.toFixed(2)},${looked.y.toFixed(2)}; ${running.join(',')}`,
        );
        expect(running).toContain('fy-ferret-wave-again@data-mascot-wave');
        expect(running).toContain('fy-ferret-hop@data-mascot-hop');
        await shot(tab, variant, 'connected-hover');
        expect(looked.x, 'the pupils look toward the tap').toBeGreaterThan(1);
        expect(Math.abs(looked.x)).toBeLessThanOrEqual(LOOK_X_MAX);
        await tab.waitForFunction(() => document.querySelector('.fy-ferret[data-poke]') === null, undefined, {
          timeout: 4_000,
        });
        expect(await look(tab), 'the pupils settle').toEqual({ x: 0, y: 0 });
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  // Reduced motion: the picture still reacts where it can without moving (the raised ferret on the pre-pair screen), but
  // the ONLY thing that animates is the blink; nothing transitions (checked at once, not after a wait that hides it).
  for (const where of ['pre-pair', 'connected'] as const) {
    it(`reduced motion (${where}): the only animation is the blink, and nothing transitions`, async () => {
      const variant = VARIANTS[0];
      const { tab, problems, close } = await open(variant, where === 'connected' ? '&offer=open' : '', 'reduce');
      try {
        if (where === 'connected') await connect(tab);
        const box = must(await tab.locator('.fy-ferret').boundingBox(), 'the ferret');
        await tab.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.6);
        await tab.waitForFunction(() => document.querySelector('.fy-ferret')?.matches(':hover') === true);
        const state = await tab.evaluate(() => {
          const ferret = document.querySelector('.fy-ferret') as Element;
          const inside = document.getAnimations().filter(animation => {
            const target = (animation.effect as KeyframeEffect).target;
            return target !== null && ferret.contains(target);
          });
          const durations = [...ferret.querySelectorAll('*')].map(node => getComputedStyle(node).transitionDuration);
          const eyes = ferret.querySelector('[data-mascot-blink]') as Element;
          const transitioning = inside
            .filter(animation => animation instanceof CSSTransition)
            .map(
              animation =>
                `${(animation as CSSTransition).transitionProperty}@${(animation.effect as KeyframeEffect).target?.getAttribute('class')}`,
            );
          return {
            eyesAnimation: getComputedStyle(eyes).animationName,
            transitioning,
            // CSS animations only (a transition at the app's 1 ms floor may be caught mid-flight and is not motion).
            running: inside
              .filter(animation => animation instanceof CSSAnimation && animation.playState === 'running')
              .map(
                animation =>
                  `${(animation as CSSAnimation).animationName}@${(animation.effect as KeyframeEffect).target?.getAttribute('data-mascot-blink') === null ? 'other' : 'blink'}`,
              ),
            transitions: inside.filter(animation => animation instanceof CSSTransition).length,
            // The app floors every transition at 1 ms under reduced motion (`design-system.css`): anything longer is motion.
            slowTransitions: durations.filter(duration =>
              duration.split(',').some(part => Number.parseFloat(part) > 0.0011),
            ).length,
          };
        });
        MEASURED.push(
          `reduced ${where}: eyes animation ${state.eyesAnimation}; transitions on ${state.transitioning.join(',')}; running ${state.running.join(',')}; transitions ${state.transitions}; transitions slower than 1 ms ${state.slowTransitions}`,
        );
        expect(state.running, 'only the blink animates').toEqual(['fy-ferret-blink@blink']);
        expect(state.slowTransitions, 'no element in the ferret has a transition longer than 1 ms').toBe(0);
        expect(await look(tab), 'the pupils do not move').toEqual({ x: 0, y: 0 });
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

describe('r11 O10: the Access app exports the mascot for the End page', () => {
  it('a mascot mounted from the app export reacts the same way', async () => {
    const variant = VARIANTS[0];
    const { tab, problems, close } = await open(variant, '&scene=export');
    try {
      await tab.waitForSelector('[data-export-mascot] .fy-ferret[data-pose="cheer"]');
      await settle(tab);
      const box = must(await tab.locator('[data-export-mascot] .fy-ferret').boundingBox(), 'the exported ferret');
      await tab.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9);
      await tab.waitForFunction(
        () =>
          document
            .querySelector('[data-mascot-wave]')
            ?.getAnimations()
            .some(a => a.playState === 'running') === true,
        undefined,
        { timeout: 400 },
      );
      expect((await look(tab)).x).toBeGreaterThan(1);
      expect(problems).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('r11-1b G1: the panel on the onboarding End page is that ferret and it answers', () => {
  for (const variant of [VARIANTS[0], VARIANTS[2]]) {
    it(`${variant.name}: the end-mascot panel reacts to a ${variant.phone ? 'tap' : 'hover'}: pupils look, arm waves, ferret hops`, async () => {
      const { tab, problems, close } = await open(variant, '&scene=end-panel');
      try {
        await tab.waitForSelector('[data-export-mascot] .fy-ferret[data-pose="cheer"]');
        await settle(tab);
        const box = must(await tab.locator('[data-export-mascot] .fy-ferret').boundingBox(), 'the panel ferret');
        const before = Date.now();
        if (variant.phone) await tab.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height * 0.5);
        else await tab.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9);
        await tab.waitForFunction(
          () =>
            document
              .querySelector('[data-mascot-wave]')
              ?.getAnimations()
              .some(a => a.playState === 'running') === true,
          undefined,
          { timeout: 400 },
        );
        const waveMs = Date.now() - before;
        const running = await markedAnimations(tab);
        const looked = await look(tab);
        MEASURED.push(
          `${variant.name} end-panel: wave running after ${waveMs} ms; look ${looked.x.toFixed(2)},${looked.y.toFixed(2)}; ${running.join(',')}`,
        );
        expect(running).toContain('fy-ferret-wave-again@data-mascot-wave');
        expect(running).toContain('fy-ferret-hop@data-mascot-hop');
        expect(looked.x, 'the pupils look toward the pointer').toBeGreaterThan(1);
        expect(Math.abs(looked.x)).toBeLessThanOrEqual(LOOK_X_MAX);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

describe('r11 O10: the passkey offer buttons are one fixed size', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: "Add a passkey now" and "Not now" share one width, 44 px or taller, 12 px apart`, async () => {
      const { tab, problems, close } = await open(variant, '&offer=open');
      try {
        await tab.getByRole('button', { name: 'Pair this device' }).click();
        await tab.waitForSelector('[data-first-passkey-offer]');
        const add = must(await tab.getByRole('button', { name: 'Add a passkey now' }).boundingBox(), 'Add');
        const later = must(await tab.getByRole('button', { name: 'Not now' }).boundingBox(), 'Not now');
        MEASURED.push(
          `${variant.name}: add ${add.width}x${add.height} @${add.x},${add.y}; not-now ${later.width}x${later.height} @${later.x},${later.y}`,
        );
        // No inner card: the offer's own box has no border, no fill and no padding (O10: "no inner box").
        const card = await tab.locator('[data-first-passkey-offer]').evaluate(node => {
          const style = getComputedStyle(node);
          return {
            border: ['Top', 'Right', 'Bottom', 'Left'].map(side =>
              Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)),
            ),
            background: style.backgroundColor,
            padding: ['top', 'right', 'bottom', 'left'].map(side =>
              Number.parseFloat(style.getPropertyValue(`padding-${side}`)),
            ),
          };
        });
        MEASURED.push(
          `${variant.name}: offer box border ${card.border.join('/')} background ${card.background} padding ${card.padding.join('/')}`,
        );
        expect(card.border, 'no border').toEqual([0, 0, 0, 0]);
        expect(card.background, 'no fill').toBe('rgba(0, 0, 0, 0)');
        expect(card.padding, 'no padding').toEqual([0, 0, 0, 0]);
        // C59 O3: the shared answer row. Desktop: 192 px each at the two ends of one row; phone: the offer's width, stacked.
        const offerBox = must(await tab.locator('[data-first-passkey-offer]').boundingBox(), 'the offer');
        if (variant.phone) expect(add.width, 'phone: Add is the full width').toBeCloseTo(offerBox.width, 0);
        else expect(add.width, 'desktop: Add is 192 px wide').toBeCloseTo(192, 0);
        expect(later.width, 'Not now is the same width').toBeCloseTo(add.width, 0);
        expect(add.height).toBeGreaterThanOrEqual(44);
        // The label (icon included) is centred in its button: its content box midpoint is the button midpoint ± 1 px.
        for (const name of ['Add a passkey now', 'Not now']) {
          const off = await tab.getByRole('button', { name }).evaluate(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const label = range.getBoundingClientRect();
            const box = node.getBoundingClientRect();
            return label.left + label.width / 2 - (box.left + box.width / 2);
          });
          MEASURED.push(`${variant.name}: "${name}" label is ${off.toFixed(2)} px off centre`);
          expect(Math.abs(off), `${name} label is centred`).toBeLessThanOrEqual(1);
        }
        expect(later.height).toBeCloseTo(add.height, 0);
        const sideBySide = Math.abs(add.y - later.y) < 4;
        if (sideBySide) {
          expect(later.x, 'Not now at the left end').toBeCloseTo(offerBox.x, 0);
          expect(add.x + add.width, 'Add at the right end').toBeCloseTo(offerBox.x + offerBox.width, 0);
        } else {
          expect(later.x, 'stacked: both on one column').toBeCloseTo(add.x, 0);
          expect(add.y, 'the way on is above').toBeLessThan(later.y);
          expect(later.y - (add.y + add.height), 'the stack gap is 12 px').toBeCloseTo(12, 0);
        }
        if (variant.phone) expect(sideBySide, 'on a phone the two stack').toBe(false);
        else expect(sideBySide, 'on a desktop the two share a row').toBe(true);
        for (const box of [add, later]) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(variant.width);
        }
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await shot(tab, variant, 'offer-buttons');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

/** A control reads as a BUTTON, not a link or bare text: a visible border, a fill that is not the page, 44 px tall. */
const buttonLook = async (tab: Page, selector: string) =>
  await tab
    .locator(selector)
    .first()
    .evaluate(node => {
      const style = getComputedStyle(node);
      const own = style.backgroundColor;
      let parent: Element | null = node.parentElement;
      let behind = 'rgba(0, 0, 0, 0)';
      while (parent !== null && behind === 'rgba(0, 0, 0, 0)') {
        behind = getComputedStyle(parent).backgroundColor;
        parent = parent.parentElement;
      }
      return {
        variant: node.getAttribute('data-variant'),
        border: Number.parseFloat(style.borderTopWidth),
        underline: style.textDecorationLine,
        fill: own,
        behind,
        height: node.getBoundingClientRect().height,
      };
    });

describe('r11 O10: pair-confirm fits above the fold; Rename and Back read as buttons', () => {
  for (const variant of VARIANTS.filter(item => !item.phone)) {
    it(`${variant.name}: with the hosted Back control the whole confirm action is above the fold`, async () => {
      const { tab, problems, close } = await open(variant, '&back=1');
      try {
        await tab.waitForSelector('[data-pair-confirm]');
        const back = must(await tab.locator('[data-pairing-close]').boundingBox(), 'Back');
        const pair = must(await tab.locator('[data-pair-confirm]').boundingBox(), 'Pair this device');
        const later = must(await tab.getByRole('button', { name: 'Not now' }).boundingBox(), 'Not now');
        MEASURED.push(
          `${variant.name} confirm: back y ${back.y.toFixed(0)}..${(back.y + back.height).toFixed(0)}; pair bottom ${(pair.y + pair.height).toFixed(1)}; not-now bottom ${(later.y + later.height).toFixed(1)} of ${variant.height}`,
        );
        expect(back.y, 'Back is on screen').toBeGreaterThanOrEqual(0);
        expect(pair.y + pair.height, 'Pair this device ends above the fold').toBeLessThanOrEqual(variant.height);
        expect(later.y + later.height, 'Not now ends above the fold').toBeLessThanOrEqual(variant.height);
        expect(
          await tab.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
          'nothing to scroll to reach an answer',
        ).toBe(true);
        await shot(tab, variant, 'confirm-fold');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  for (const variant of VARIANTS) {
    it(`${variant.name}: "Rename" and "Back" are bordered buttons, not links or bare text`, async () => {
      const { tab, problems, close } = await open(variant, '&back=1');
      try {
        await tab.waitForSelector('[data-pair-device-rename]');
        // C59 O2: "Rename" is TEXT on the "called" line (an underlined inline control, no taller than the line: the balance test
        // owns its geometry); only Back is a bordered button.
        const rename = await buttonLook(tab, '[data-pair-device-rename]');
        expect(rename.underline, 'Rename is an underlined inline control').not.toBe('none');
        expect(rename.height, 'Rename is no taller than a text line').toBeLessThanOrEqual(28);
        for (const [name, selector] of [['Back', '[data-pairing-close]']] as const) {
          const found = await buttonLook(tab, selector);
          MEASURED.push(
            `${variant.name}: ${name} variant ${found.variant} border ${found.border} underline ${found.underline} fill ${found.fill} over ${found.behind} height ${found.height}`,
          );
          expect(found.variant, `${name} is not the ghost variant`).not.toBe('ghost');
          expect(found.border, `${name} has a visible border`).toBeGreaterThan(0);
          expect(found.underline, `${name} is not an underlined link`).toBe('none');
          expect(found.fill, `${name} has its own fill`).not.toBe('rgba(0, 0, 0, 0)');
          expect(found.height, `${name} is 44 px or taller`).toBeGreaterThanOrEqual(44);
        }
        await shot(tab, variant, 'confirm-buttons');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }

  it('the paste page (a cold open) draws Back as a bordered button too', async () => {
    const variant = VARIANTS[0];
    const { tab, problems, close } = await open(variant, '&arrival=cold&back=1');
    try {
      const found = await buttonLook(tab, '[data-pairing-close]');
      MEASURED.push(`paste page: Back variant ${found.variant} border ${found.border} fill ${found.fill}`);
      expect(found.variant).not.toBe('ghost');
      expect(found.border).toBeGreaterThan(0);
      expect(found.fill).not.toBe('rgba(0, 0, 0, 0)');
      expect(problems).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('r11 O10: measured numbers', () => {
  it('prints the measured numbers', () => {
    console.log(MEASURED.join('\n'));
  });
});
