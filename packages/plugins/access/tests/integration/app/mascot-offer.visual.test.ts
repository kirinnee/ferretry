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
  await tab.waitForSelector('[data-pairing-stage]');
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

/** The names of the CSS animations running on the mascot now. */
const ferretAnimations = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(() =>
    document
      .getAnimations()
      .filter(animation => animation.playState === 'running' && animation instanceof CSSAnimation)
      .filter(animation => (animation.effect as KeyframeEffect).target?.closest('.fy-ferret') !== null)
      .map(animation => (animation as CSSAnimation).animationName),
  );

const MEASURED: string[] = [];

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

  it('reduced motion: the hover still shows (it rises) but nothing moves', async () => {
    const variant = VARIANTS[0];
    const { tab, problems, close } = await open(variant, '', 'reduce');
    try {
      const rest = await sink(tab);
      const box = must(await tab.locator('.fy-ferret').boundingBox(), 'the ferret');
      await tab.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5);
      await tab.waitForFunction(() => document.querySelector('.fy-ferret')?.matches(':hover') === true);
      expect(await sink(tab)).toBeLessThanOrEqual(rest - 12);
      expect(await ferretAnimations(tab), 'no ferret animation runs under reduced motion').toEqual([]);
      const running = await tab.evaluate(() => document.querySelector('.fy-ferret-body')?.getAnimations().length ?? -1);
      expect(running, 'the body has no transition or animation under reduced motion').toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await close();
    }
  });
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
        expect(add.width, 'Add is 192 px wide').toBeCloseTo(192, 0);
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
        if (sideBySide) expect(later.x - (add.x + add.width), 'the row gap is 12 px').toBeCloseTo(12, 0);
        else {
          expect(later.x, 'stacked: both on one column').toBeCloseTo(add.x, 0);
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

  it('prints the measured numbers', () => {
    console.log(MEASURED.join('\n'));
  });
});
