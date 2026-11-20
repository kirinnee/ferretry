/**
 * THE r10-1 ONBOARDING GATE, END TO END, in a real browser: the REAL app over every shipped plugin's own app half
 * (`fixtures/onboarding-e2e-scene.tsx`), an empty paired list and TWO stateful fake machines
 * (`fixtures/onboarding-e2e-daemon.ts`, `…-routes.ts`) that remember what the pages told them. No daemon, no network, no
 * real home: every name and path is made up, and the pairing code is the fixed fake one (`ABCD-EFGH`), never a real one.
 *
 * ONE JOURNEY, in one browser context (so the second part sees what the first left on the device):
 *
 *   First time: install skipped -> pair (fake code) -> Machine name -> Claude (installed, signed in, Choose -> settings /
 *   skills pages -> import -> permission) -> Codex (Import everything) -> Warden -> Lessons -> Shells skipped (nix found)
 *   -> This device: Appearance, Layout, Voice -> end page.
 *   Then a SECOND machine: the "Only on <machine>" chip shows, and the Pair journey skips what this device already set.
 *
 * AT EVERY PAGE: no sidebar or app chrome, no sideways scroll, the living background is moving, Back and Next work (Back
 * goes to the page the person came from, Next returns), the footer buttons are auto width and 44px tall, and (daemon side)
 * the step really records on the machine, exactly once. An arrow key moves a card's selection and writes nothing.
 *
 * The GAPS the run found are one plain test each below (they were `it.failing` until the product was fixed).
 *
 *   FY_ONBOARDING_E2E_VARIANTS   comma list of `<width>-<light|dark>` (default `1280-light,390-dark`)
 *   FY_ONBOARDING_E2E_SHOTS_DIR  keep `<variant>-<nn>-<page>.png` of every page (fake data only)
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';
import { clippedBoxes, footerButtons, gapUnderTitle, underFooter } from '../support/browser/stepper-layout.ts';
import { FAKE_CODE, MACHINE_A, MACHINE_B, pairLinkOf } from './fixtures/onboarding-e2e-daemon.ts';

setDefaultTimeout(280_000);

const scene = new URL('./fixtures/onboarding-e2e-scene.tsx', import.meta.url).pathname;
const shotsDir = process.env.FY_ONBOARDING_E2E_SHOTS_DIR ?? '';
const VARIANTS = (process.env.FY_ONBOARDING_E2E_VARIANTS ?? '1280-light,390-dark').split(',').map(name => {
  const [width = '1280', scheme = 'light'] = name.trim().split('-');
  return { name: name.trim(), width: Number(width), height: Number(width) < 600 ? 844 : 800, dark: scheme === 'dark' };
});

let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 120_000);

afterAll(() => {
  server?.kill();
});

// ─── what the run saw (read by the gap tests below) ────────────────────────────────────────────────────────
interface Observed {
  /** `[data-name-machine]` forms on screen on the Machine name page. */
  nameForms: number;
  /** App chrome elements on the pairing page, reached from the first run. */
  pairPageChrome: number;
  /** App chrome elements on the pairing page's "Connected" screen. */
  pairConnectedChrome: number;
  /** `<variant>:<page>` of every page whose Back/Next footer is below the first screen. */
  footerOffScreen: string[];
  /** Action buttons on the pairing pages that are the row wide or under 44px tall. */
  badButtons: string[];
  /** Codex import kind pages walked in Import everything mode (the gate says that mode is ONE page). */
  codexKindPagesInEverything: number;
  /** Requests the fake machines had no answer for. */
  unanswered: string[];
  pageErrors: string[];
  /** Every page's counter and segment count, in order (printed with FY_ONBOARDING_E2E_SHOTS_DIR). */
  counters: string[];
}
const seen: Observed = {
  nameForms: -1,
  pairPageChrome: -1,
  pairConnectedChrome: -1,
  footerOffScreen: [],
  badButtons: [],
  codexKindPagesInEverything: -1,
  unanswered: [],
  pageErrors: [],
  counters: [],
};

// ─── small helpers ───────────────────────────────────────────────────────────────────────────────────────────────
interface Variant {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly dark: boolean;
}

const CHROME = '[data-slot="nav"], [data-slot="bottom"], [data-slot="phone-title"], [data-drawer-find], .fy-drawer';

interface FakeView {
  answers: { plugin: string; id: string; state: string }[];
  states: Record<string, string>;
  mutations: { route: string; body: unknown }[];
  writes: { route: string; body: unknown }[];
  unanswered: string[];
}
const daemonOf = async (tab: Page, id: string): Promise<FakeView> =>
  await tab.evaluate(
    daemon => (window as unknown as { __fake: { daemon: (id: string) => unknown } }).__fake.daemon(daemon) as never,
    id,
  );
const ledgerOf = async (tab: Page): Promise<Record<string, { daemons: string[] }>> =>
  await tab.evaluate(() => {
    const raw = window.localStorage.getItem('fy:onboarding:client');
    return raw === null ? {} : (JSON.parse(raw) as { steps: Record<string, { daemons: string[] }> }).steps;
  });

const keyOf = async (tab: Page): Promise<string> =>
  await tab.evaluate(() => {
    if (document.querySelector('[data-flow-end]') !== null) return 'end';
    return document.querySelector('[data-flow-page]')?.getAttribute('data-flow-page') ?? '';
  });

/** Waits until the flow shows `key` (or the end) READY: the cover is down and the page has said so. */
const reach = async (tab: Page, key: string): Promise<void> => {
  try {
    await tab.waitForFunction(
      wanted => {
        if (wanted === 'end') return document.querySelector('[data-flow-end]') !== null;
        const page = document.querySelector('[data-flow-page]');
        return page?.getAttribute('data-flow-page') === wanted && page.hasAttribute('data-ready');
      },
      key,
      { timeout: 15_000 },
    );
  } catch {
    throw new Error(`expected the flow on ${key} but it is on ${await keyOf(tab)}`);
  }
  // The slide-in finishes before anything is measured or shot.
  await tab.waitForTimeout(350);
};

/** The flow's pages in the order they were reached (a page the flow dropped is never in it). */
const walked: string[] = [];

const shotCounter = { n: 0 };
const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  shotCounter.n += 1;
  if (shotsDir === '') return;
  await tab.screenshot({
    path: join(shotsDir, `${variant.name}-${String(shotCounter.n).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
};

/** What every flow page must satisfy, whatever it is. */
const inspect = async (tab: Page, variant: Variant, key: string, opts: { first?: boolean } = {}): Promise<void> => {
  const read = await tab.evaluate(chrome => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const footer = [...document.querySelectorAll('[data-step-footer] button')].map(button => ({
      label: (button.textContent ?? '').trim(),
      w: rect(button).width,
      h: rect(button).height,
    }));
    const grid = document.querySelector('.fy-lb[data-live] .fy-lb-grid');
    const streak = document.querySelector('.fy-lb[data-live] .fy-lb-streak');
    return {
      chrome: document.querySelectorAll(chrome).length,
      unsaved: document.querySelectorAll('[data-flow-unsaved]').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      livingBackground: document.querySelector('[data-living-background][data-live]') !== null,
      breathing: grid === null ? 'none' : getComputedStyle(grid).animationName,
      streaks: document.querySelectorAll('.fy-lb-streak').length,
      streakMoving: streak === null ? 'none' : getComputedStyle(streak).animationName,
      footer,
      footerBottom: document.querySelector('[data-step-footer]')?.getBoundingClientRect().bottom ?? 0,
      back: document.querySelectorAll('[data-step-back]').length,
      next: document.querySelectorAll('[data-step-next]').length,
      nextOff: (document.querySelector('[data-step-next]') as HTMLButtonElement | null)?.disabled ?? true,
      counter: (() => {
        const bar = document.querySelector('[data-step-progress] [role="progressbar"]');
        const segments = [...document.querySelectorAll<HTMLElement>('[data-step-progress] [data-segment]')];
        const here = segments.find(segment => segment.dataset.state === 'current');
        return {
          text: document.querySelector('.fy-sp-progress__text')?.textContent ?? '',
          now: Number(bar?.getAttribute('aria-valuenow')),
          max: Number(bar?.getAttribute('aria-valuemax')),
          states: segments.map(segment => segment.dataset.state ?? ''),
          label: here?.textContent ?? '',
          fill:
            here === undefined
              ? Number.NaN
              : Number.parseFloat(getComputedStyle(here).getPropertyValue('--fy-sp-fill')),
        };
      })(),
    };
  }, CHROME);
  // ONE counter meaning on every page: "<segment> · n of m" says what the bar draws (one lit segment, the ones before it
  // done, the current one filled n of m), and n is never past m.
  const said = /^(.*) · page (\d+) of (\d+)$/u.exec(read.counter.text);
  expect(said, `${key}: the counter reads '<segment> · page n of m' (read '${read.counter.text}')`).not.toBeNull();
  const [, , saidN = '', saidM = ''] = said ?? [];
  expect([Number(saidN), Number(saidM)], `${key}: the counter and the progress bar say the same numbers`).toEqual([
    read.counter.now,
    read.counter.max,
  ]);
  expect(read.counter.now, `${key}: n is not past m`).toBeLessThanOrEqual(read.counter.max);
  expect(
    read.counter.states.filter(state => state === 'current'),
    `${key}: exactly one segment is current`,
  ).toHaveLength(1);
  const at = read.counter.states.indexOf('current');
  expect(
    read.counter.states.every((state, index) => state === (index < at ? 'done' : index === at ? 'current' : 'ahead')),
    `${key}: the bar reads left to right (${read.counter.states.join(',')})`,
  ).toBe(true);
  expect(read.counter.text.startsWith(read.counter.label), `${key}: the counter names the lit segment`).toBe(true);
  expect(read.counter.fill, `${key}: the lit segment is filled n of m`).toBeCloseTo(
    read.counter.now / read.counter.max,
    3,
  );
  if (shotsDir !== '')
    appendFileSync(
      join(shotsDir, `${variant.name}-counters.txt`),
      `${key}: ${read.counter.text} [${read.counter.states.length} segments]\n`,
    );
  seen.counters.push(`${variant.name}:${key}: ${read.counter.text} [${read.counter.states.length} segments]`);
  expect(read.chrome, `${key}: no sidebar or app chrome`).toBe(0);
  expect(read.unsaved, `${key}: no "answer was not saved" notice`).toBe(0);
  expect(read.overflow, `${key}: no sideways scroll`).toBeLessThanOrEqual(0);
  expect(read.livingBackground, `${key}: the living background is up`).toBe(true);
  expect(read.breathing, `${key}: the grid breathes`).toBe('fy-lb-breathe');
  expect(read.streaks, `${key}: shooting stars`).toBeGreaterThanOrEqual(3);
  expect(read.streakMoving, `${key}: a shooting star moves`).toBe('fy-lb-shoot');
  expect(read.next, `${key}: a Next button`).toBe(1);
  expect(read.nextOff, `${key}: Next is on`).toBe(false);
  expect(read.back, `${key}: Back ${opts.first === true ? 'is absent on the first page' : 'is there'}`).toBe(
    opts.first === true ? 0 : 1,
  );
  // Collected, not asserted here: the gate found pages whose Back/Next footer sits below the first screen (see the gaps below).
  if (read.footerBottom > variant.height + 1) seen.footerOffScreen.push(`${variant.name}:${key}`);
  for (const button of read.footer) {
    expect(button.w, `${key}: ${button.label} is not full width`).toBeLessThan(
      (variant.width < 600 ? 0.7 : 0.5) * variant.width,
    );
    expect(button.h, `${key}: ${button.label} is a 44px target`).toBeGreaterThanOrEqual(43.5);
  }
  // Item 3: the title sits right over the page (no dead band between them), and Later is a real button in the footer row
  // (Back · Later · Next), never a link floating in the page.
  const gap = await gapUnderTitle(tab, '.fy-spf__head', '.fy-spf__body');
  expect(gap.gap, `${key}: something is drawn under the title (first: ${gap.first})`).toBeGreaterThanOrEqual(0);
  expect(gap.gap, `${key}: no dead gap between the title and the page (first thing: ${gap.first})`).toBeLessThanOrEqual(
    40,
  );
  const row = await footerButtons(tab);
  expect(
    row.map(button => button.label),
    `${key}: the footer row is Back · Later · Next`,
  ).toEqual(opts.first === true ? ['Later', 'Next'] : ['Back', 'Later', 'Next']);
  expect(
    Math.max(...row.map(button => button.y)) - Math.min(...row.map(button => button.y)),
    `${key}: one row`,
  ).toBeLessThan(2);
  expect(row.find(button => button.label === 'Later')?.mark, `${key}: Later is the frame's own button`).toContain(
    'data-step-later',
  );
  expect(await tab.locator('.fy-spf__page [data-flow-later]').count(), `${key}: no Later link inside the page`).toBe(0);
  // Item 5: at the end of the scroll nothing the page draws sits under the sticky footer (every element measured, not one marker).
  expect(
    await underFooter(tab, '[data-step-footer]'),
    `${key}: nothing is under the footer at the end of the scroll`,
  ).toEqual([]);
};

/** The get-started pages (install, daemon, open): 44px choices and buttons, the command fully on screen, nothing under the footer. */
const stagePage = async (tab: Page, variant: Variant, key: string): Promise<void> => {
  // The proof picture: the page scrolled to its very end (the first-screen shot cannot show what the footer covers).
  if (shotsDir !== '') {
    await tab.evaluate(() => {
      const bar = document.querySelector('.fy-ob-sticky');
      for (let el: Element | null = bar?.parentElement ?? null; el !== null; el = el.parentElement)
        if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await tab.waitForTimeout(150);
    await tab.screenshot({ path: join(shotsDir, `${variant.name}-${key}-scrolled-to-end.png`) });
    await tab.evaluate(() => {
      const bar = document.querySelector('.fy-ob-sticky');
      for (let el: Element | null = bar?.parentElement ?? null; el !== null; el = el.parentElement) el.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  }
  expect(
    await underFooter(tab, '.fy-ob-sticky'),
    `${key}: nothing is under the footer at the end of the scroll`,
  ).toEqual([]);
  expect(await clippedBoxes(tab, '[data-onboarding]'), `${key}: no box hides what it holds`).toEqual([]);
  const heights = await tab
    .locator('[data-onboarding-channel], [data-onboarding-actions] button, [data-onboarding-agent-instead]')
    .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height * 10) / 10));
  // A button that offers something (Let an agent do it, the OS choices) has a border: never a plain text line in a sentence.
  for (const borderless of await tab
    .locator('[data-onboarding-channel], [data-onboarding-agent-instead]')
    .evaluateAll(nodes =>
      nodes
        .filter(node => Number.parseFloat(getComputedStyle(node).borderTopWidth) === 0)
        .map(node => (node.textContent ?? '').trim()),
    ))
    expect(borderless, `${key}: a choice or offer without a border`).toBe('');
  for (const height of heights)
    expect(height, `${key}: every choice and footer button is 44px tall`).toBeGreaterThanOrEqual(43.5);
};

/** Collects a button that is the row wide or under 44px tall (read by the gap below, not asserted here). */
const measureButton = async (tab: Page, variant: Variant, label: string, selector: string): Promise<void> => {
  const box = await tab.locator(selector).first().boundingBox();
  if (box === null) return;
  const limit = (variant.width < 600 ? 0.7 : 0.5) * variant.width;
  if (box.width >= limit || box.height < 43.5)
    seen.badButtons.push(`${variant.name}:${label} (${Math.round(box.width)}x${Math.round(box.height)})`);
};

/** Presses Next and waits for `to` (a page key, or `end`). */
const next = async (tab: Page, to: string): Promise<void> => {
  await tab.locator('[data-step-next]').click();
  await reach(tab, to);
};

/** Back then Next: Back lands on the page the person came from and Next comes straight back. */
const backAndForth = async (tab: Page, from: string, key: string): Promise<void> => {
  await tab.locator('[data-step-back]').click();
  await reach(tab, from);
  await next(tab, key);
};

/** The daemon has taken an answer for the step (`<plugin>.<step>`), and the page has not been answered twice. */
const recorded = async (tab: Page, daemon: string, key: string): Promise<string> => {
  const [plugin = '', id = ''] = key.split('.');
  await tab.waitForFunction(
    ([machine, step]) => {
      const view = (
        window as unknown as { __fake: { daemon: (id: string) => { states: Record<string, string> } } }
      ).__fake.daemon(machine as string);
      return view.states[step as string] !== undefined;
    },
    [daemon, key],
    { timeout: 8_000 },
  );
  const view = await daemonOf(tab, daemon);
  expect(
    view.answers.filter(answer => answer.plugin === plugin && answer.id === id).length,
    `${key}: answered on the machine exactly once`,
  ).toBe(1);
  return view.states[key] as string;
};

/** A page that asks something and answers with Next: the daemon holds `done` for it afterwards. */
const answerWithNext = async (
  tab: Page,
  variant: Variant,
  daemon: string,
  key: string,
  to: string,
  opts: { first?: boolean; before?: string } = {},
): Promise<void> => {
  await reach(tab, key);
  walked.push(key);
  await inspect(tab, variant, key, opts.first === true ? { first: true } : {});
  await shot(tab, variant, key);
  if (opts.first !== true && opts.before !== undefined) await backAndForth(tab, opts.before, key);
  await next(tab, to);
  expect(await recorded(tab, daemon, key), `${key}: the machine recorded the answer`).toBe('done');
};

const counterOf = async (tab: Page): Promise<string> =>
  (await tab.locator('.fy-sp-progress__text').textContent()) ?? '';

/** The counters one variant printed so far, as `{ key, n, of, bar }` (see `inspect`). */
const countersOf = (variant: Variant): { key: string; n: number; of: number; bar: number }[] =>
  seen.counters
    .filter(line => line.startsWith(`${variant.name}:`))
    .map(line => {
      const read = /^[^:]+:(\S+): .* · page (\d+) of (\d+) \[(\d+) segments\]$/u.exec(line);
      return { key: read?.[1] ?? '', n: Number(read?.[2]), of: Number(read?.[3]), bar: Number(read?.[4]) };
    });

/** The ending: ONE primary 44px button (the footer's "Open this machine"), the rest real secondary buttons, a summary, nothing under the footer. */
const endPage = async (tab: Page, variant: Variant, key: string): Promise<void> => {
  const row = await footerButtons(tab);
  expect(
    row.map(button => button.label),
    `${key}: the footer is Back · Open this machine`,
  ).toEqual(['Back', 'Open this machine']);
  expect(
    await tab.locator('[data-variant="primary"]:visible').count(),
    `${key}: exactly one primary button on the page`,
  ).toBe(1);
  expect(
    await tab.locator('[data-step-footer] [data-variant="primary"]').innerText(),
    `${key}: the one primary is Open this machine`,
  ).toBe('Open this machine');
  // The summary's finish-later links are quiet text links (a 44px target, no box); every BUTTON on the ending is a real, bordered 44px one.
  for (const link of await tab.locator('[data-onboarding-summary] a').all())
    expect((await link.boundingBox())?.height ?? 0, `${key}: a summary link is a 44px target`).toBeGreaterThanOrEqual(
      43.5,
    );
  for (const button of await tab.locator('[data-flow-end] button, [data-onboarding-summary] button').all()) {
    const read = await button.evaluate(node => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        label: (node.textContent ?? '').trim(),
        h: box.height,
        w: box.width,
        border: Number.parseFloat(style.borderTopWidth),
        variant: node.getAttribute('data-variant'),
        underline: style.textDecorationLine,
      };
    });
    expect(read.h, `${key}: ${read.label} is a 44px target`).toBeGreaterThanOrEqual(43.5);
    // A phone's two ways to start fill their row on purpose (the owner asked for fixed, even widths); a desktop's never do.
    expect(read.w, `${key}: ${read.label} fits the screen`).toBeLessThanOrEqual(variant.width);
    if (variant.width >= 600)
      expect(read.w, `${key}: ${read.label} is not full width`).toBeLessThan(0.5 * variant.width);
    expect(read.border, `${key}: ${read.label} is a real (bordered) secondary button`).toBeGreaterThan(0);
    expect(read.variant, `${key}: ${read.label} is not a ghost or text button`).not.toBe('ghost');
    expect(read.underline, `${key}: ${read.label} is not underlined text`).toBe('none');
  }
  expect(await tab.locator('[data-onboarding-summary]').count(), `${key}: a summary of what was set up`).toBe(1);
  expect(
    await underFooter(tab, '[data-step-footer]'),
    `${key}: nothing is under the footer at the end of the scroll`,
  ).toEqual([]);
  const gap = await gapUnderTitle(tab, '.fy-spf__head', '.fy-spf__body');
  expect(gap.gap, `${key}: no dead gap under the title`).toBeLessThanOrEqual(40);
};

// ─── the journey ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the first run, end to end', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: First time, then a second machine's Pair journey`, async () => {
      shotCounter.n = 0;
      walked.length = 0;
      const browser = await sharedChromium();
      const phone = variant.width < 600;
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        colorScheme: variant.dark ? 'dark' : 'light',
        deviceScaleFactor: phone ? 2 : 1,
        hasTouch: phone,
        isMobile: phone,
      });
      // No network: only the scene's own origin answers.
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      tab.setDefaultTimeout(20_000);
      tab.on('pageerror', error => seen.pageErrors.push(error.message));
      const consoleLines: string[] = [];
      tab.on('console', message => consoleLines.push(message.text()));
      const A = MACHINE_A.id;
      const B = MACHINE_B.id;
      const theme = `studio-${variant.dark ? 'dark' : 'light'}`;
      const navigate = async (to: string): Promise<void> => {
        await tab.evaluate(path => {
          history.pushState(null, '', path);
          dispatchEvent(new PopStateEvent('popstate'));
        }, to);
      };
      // The scene serves `/pair`; the first run is reached the way the app reaches it, from the empty home.
      await tab.goto(`${origin}/pair?theme=${theme}`);
      await tab.waitForSelector('[data-slot="nav"], [data-slot="bottom"], .fy-main');
      await navigate('/');

      // ── the start screen: three cards, nothing started by a select, no chrome ────────────────────────────────────
      await tab.waitForSelector('[data-choice-cards]');
      expect(await tab.locator(CHROME).count(), 'the start screen has no app chrome').toBe(0);
      await shot(tab, variant, 'start');
      await tab.locator('label[data-choice="first-time"]').click();
      expect(await tab.locator('[data-onboarding]').getAttribute('data-onboarding-screen')).toBe('entry');
      await tab.locator('[data-onboarding-continue]').click();

      // ── install: skipped (the daemon is "already running": Next, Next) ───────────────────────────────────────────
      await tab.waitForSelector('[data-onboarding-next]');
      expect(await tab.locator(CHROME).count(), 'the install page has no app chrome').toBe(0);
      await shot(tab, variant, 'install');
      await stagePage(tab, variant, 'install');
      await tab.locator('[data-onboarding-next]').click();
      await tab.waitForSelector('[data-onboarding-next]');
      await shot(tab, variant, 'daemon');
      await stagePage(tab, variant, 'daemon');
      await tab.locator('[data-onboarding-next]').click();
      await tab.waitForSelector('[data-onboarding-back]');
      await shot(tab, variant, 'open');
      await stagePage(tab, variant, 'open');

      // ── pair: the pairing page, a pasted link with the FIXED FAKE code, confirm ──────────────────────────────────
      await tab.getByText('It did not open a browser').click();
      await tab.locator('[data-onboarding-open-pair]').click();
      await tab.getByText('Paste a link').click();
      seen.pairPageChrome = await tab.locator(CHROME).count();
      await shot(tab, variant, 'pair-paste');
      await tab.getByLabel('Pairing link').fill(pairLinkOf(MACHINE_A, origin));
      await tab.getByText('Use this link').click();
      await tab.locator('[data-pair-confirm]').waitFor();
      await shot(tab, variant, 'pair-confirm');
      await measureButton(tab, variant, 'Pair this device', '[data-pair-confirm]');
      // Item 4: "Not now" is a real, bordered 44px button, not an underlined text link.
      const notNow = await tab.getByRole('button', { name: 'Not now' }).evaluate(node => {
        const style = getComputedStyle(node);
        return {
          h: node.getBoundingClientRect().height,
          border: Number.parseFloat(style.borderTopWidth),
          underline: style.textDecorationLine,
          button: node.tagName,
          real: node.classList.contains('kt-btn'),
        };
      });
      expect(notNow, 'pair-confirm: Not now is a real button, 44px, no underline').toMatchObject({
        button: 'BUTTON',
        real: true,
        underline: 'none',
      });
      expect(notNow.h, 'pair-confirm: Not now is 44px tall').toBeGreaterThanOrEqual(43.5);
      expect(notNow.border, 'pair-confirm: Not now has a border like a button').toBeGreaterThan(0);
      await tab.locator('[data-pair-confirm]').click();

      // ── the setup flow opens on the machine that answered ───────────────────────────────────────────────────────
      await tab.waitForURL(/\/onboarding\/setup\?phase=daemon&journey=first-time/u);
      await reach(tab, 'onboarding.name');
      walked.push('onboarding.name');
      seen.nameForms = await tab.locator('[data-name-machine]').count();
      // The flow's page title is "Name this machine"; the form under it draws no second heading with the same words.
      expect(
        await tab
          .locator('h1:visible, h2:visible, h3:visible')
          .evaluateAll(nodes => nodes.filter(node => (node.textContent ?? '').trim() === 'Name this machine').length),
        'Machine name: "Name this machine" is a heading once, not twice',
      ).toBe(1);
      await inspect(tab, variant, 'onboarding.name', { first: true });
      // The name form's own buttons are the 44px, auto width buttons of the footer (not a 28px row of small ones).
      for (const button of await tab.locator('[data-flow-page="onboarding.name"] form button').all()) {
        const box = await button.boundingBox();
        expect(box?.height ?? 0, 'Machine name: Save name / Not now are 44px tall').toBeGreaterThanOrEqual(43.5);
        expect(box?.width ?? 0, 'Machine name: its buttons are auto width').toBeLessThan(0.5 * variant.width);
      }
      await shot(tab, variant, 'onboarding.name');
      // Save the name: the machine takes it through the host file, and the flow goes on by itself.
      await tab.getByLabel('Machine name').last().fill('studio-mac');
      await tab.getByRole('button', { name: 'Save name' }).last().click();
      await reach(tab, 'claude-code.import-choice');
      expect(
        (await daemonOf(tab, A)).writes.some(write => write.route === 'PUT /v1/config/file'),
        'the name went to the machine',
      ).toBe(true);
      expect(await recorded(tab, A, 'onboarding.name'), 'Machine name recorded').toMatch(/done|skipped/u);

      // ── Claude: installed and signed in are never asked; Choose what to import ──────────────────────────────────
      walked.push('claude-code.import-choice');
      await inspect(tab, variant, 'claude-code.import-choice');
      // Item 1: the count is known from the answer BEFORE the next page: Import everything (the default) will show 4 pages, not 9.
      expect(await counterOf(tab), 'Claude: Import everything counts the pages it will show').toBe(
        'Claude Code · page 1 of 4',
      );
      await shot(tab, variant, 'claude-code.import-choice');
      await backAndForth(tab, 'onboarding.name', 'claude-code.import-choice');
      // An arrow key moves the FOCUS and writes nothing: no request, no answer, nothing on the device ledger, and the
      // card is not chosen until Enter (or Space, or a click).
      const before = await daemonOf(tab, A);
      const ledgerBefore = JSON.stringify(await ledgerOf(tab));
      await tab.locator('input[name]:checked, input[type="radio"]:checked').first().focus();
      await tab.keyboard.press('ArrowRight');
      await tab.waitForTimeout(300);
      const after = await daemonOf(tab, A);
      expect(after.mutations.length, 'an arrow key sent nothing to the machine').toBe(before.mutations.length);
      expect(after.answers.length, 'an arrow key recorded no answer').toBe(before.answers.length);
      expect(JSON.stringify(await ledgerOf(tab)), 'an arrow key wrote nothing on this device').toBe(ledgerBefore);
      expect(
        await tab.locator('label[data-choice="choose"]').getAttribute('data-selected'),
        'the arrow chose nothing',
      ).toBe('false');
      await tab.keyboard.press('Enter');
      await tab.waitForTimeout(300);
      expect(await tab.locator('label[data-choice="choose"]').getAttribute('data-selected'), 'Enter chose it').toBe(
        'true',
      );
      // Item 1 (continued): Enter picked Choose, so the count is already 9 on this very page, not a page later.
      expect(await counterOf(tab), 'Claude: Choose counts all of its pages as soon as it is picked').toBe(
        'Claude Code · page 1 of 9',
      );
      await tab.locator('label[data-choice="choose"]').click();
      await shot(tab, variant, 'claude-code.import-choice-chosen');
      await next(tab, 'claude-code.import-settings');
      expect(await recorded(tab, A, 'claude-code.import-choice')).toBe('done');
      for (const [key, to] of [
        ['claude-code.import-settings', 'claude-code.import-model-set'],
        ['claude-code.import-model-set', 'claude-code.import-instructions'],
        ['claude-code.import-instructions', 'claude-code.import-skills'],
        ['claude-code.import-skills', 'claude-code.import-mcp'],
        ['claude-code.import-mcp', 'claude-code.conversations'],
      ] as const) {
        walked.push(key);
        await inspect(tab, variant, key);
        await shot(tab, variant, key);
        if (key === 'claude-code.import-skills') {
          // A kind page's tick is the run's memory, not a write: leave one skill out and nothing is sent.
          const mutations = (await daemonOf(tab, A)).mutations.length;
          await tab.locator('input[type="checkbox"]').last().uncheck();
          expect((await daemonOf(tab, A)).mutations.length, 'a tick sent nothing').toBe(mutations);
        }
        await next(tab, to);
        expect(await recorded(tab, A, key)).toBe('done');
      }
      await answerWithNext(tab, variant, A, 'claude-code.conversations', 'claude-code.import-run');

      // The import page: name the runtime and import; the machine gets a proposal and applies it.
      await reach(tab, 'claude-code.import-run');
      walked.push('claude-code.import-run');
      await inspect(tab, variant, 'claude-code.import-run');
      await shot(tab, variant, 'claude-code.import-run');
      await tab.getByRole('button', { name: 'Import', exact: true }).click();
      await tab.waitForFunction(
        id =>
          (window as unknown as { __fake: { daemon: (id: string) => { mutations: { route: string }[] } } }).__fake
            .daemon(id)
            .mutations.some(mutation => /\/v1\/runtimes\/proposals\/[^/]+\/apply$/u.test(mutation.route)),
        A,
        { timeout: 10_000 },
      );
      await tab.waitForTimeout(500);
      await shot(tab, variant, 'claude-code.import-run-done');
      await tab.locator('[data-step-next]').waitFor();
      await next(tab, 'claude-code.permission');
      expect(await recorded(tab, A, 'claude-code.import-run')).toBe('done');

      // Permission: an arrow key moves the focus and writes nothing; Keep leaves the default.
      await reach(tab, 'claude-code.permission');
      walked.push('claude-code.permission');
      await inspect(tab, variant, 'claude-code.permission');
      await shot(tab, variant, 'claude-code.permission');
      const permBefore = (await daemonOf(tab, A)).mutations.length;
      await tab.locator('input[type="radio"]:checked').first().focus();
      await tab.keyboard.press('ArrowUp');
      await tab.waitForTimeout(300);
      expect((await daemonOf(tab, A)).mutations.length, 'an arrow key on Permissions wrote nothing').toBe(permBefore);
      expect(await tab.getByRole('button', { name: /^Keep / }).count(), 'an arrow key chose no other card').toBe(0);
      // Enter chooses the focused card; that alone still writes nothing (the page's own Use / Keep does).
      await tab.keyboard.press('Enter');
      await tab.waitForTimeout(300);
      expect((await daemonOf(tab, A)).mutations.length, 'choosing a card on Permissions wrote nothing').toBe(
        permBefore,
      );
      await shot(tab, variant, 'claude-code.permission-picked');
      await tab.getByRole('button', { name: /^Keep / }).click();
      await tab.waitForTimeout(300);
      await next(tab, 'codex.import-choice');
      expect(await recorded(tab, A, 'claude-code.permission')).toBe('done');

      // ── Codex: Import everything ────────────────────────────────────────────────────────────────────────────────
      await reach(tab, 'codex.import-choice');
      walked.push('codex.import-choice');
      await inspect(tab, variant, 'codex.import-choice');
      await shot(tab, variant, 'codex.import-choice');
      // Everything is already selected: Next is the answer. Count the pages Codex then walks before the Warden.
      await tab.locator('[data-step-next]').click();
      let codexPages = 0;
      for (;;) {
        await tab.waitForTimeout(500);
        const key = await keyOf(tab);
        if (!key.startsWith('codex.')) break;
        codexPages += 1;
        walked.push(key);
        await inspect(tab, variant, key);
        await shot(tab, variant, key);
        await tab.locator('[data-step-next]').click();
      }
      seen.codexKindPagesInEverything = walked.filter(key =>
        /^codex\.import-(settings|model-set|instructions|skills|mcp)$/u.test(key),
      ).length;
      expect(codexPages, 'Codex walked at least its own page').toBeGreaterThanOrEqual(1);
      expect((await daemonOf(tab, A)).states['codex.import-choice'], 'Codex choice recorded').toBe('done');

      // ── Warden, Lessons ─────────────────────────────────────────────────────────────────────────────────────────
      await reach(tab, 'warden.warden');
      walked.push('warden.warden');
      await inspect(tab, variant, 'warden.warden');
      await shot(tab, variant, 'warden.warden');
      // r11 O7 (the Jev key is set up ON this page): the REAL Warden page over the REAL registered Voice key row, the machine
      // faked at the daemon boundary. A card pick writes nothing; the key row is Voice's own `speedup-key` panel; Save is one
      // vault write; the key is then in no DOM, storage or console line; Next is ONE write of warden.yaml (naming the key).
      const wardenPage = tab.locator('[data-flow-page="warden.warden"]');
      const writesOf = async (route: string) => (await daemonOf(tab, A)).writes.filter(write => write.route === route);
      expect(await wardenPage.locator('input[type=password]').count(), 'Rules only draws no key field').toBe(0);
      await wardenPage.locator('label[data-choice="jev"]').click();
      const field = wardenPage.locator('[data-warden-key-row] input[type=password]');
      await field.waitFor({ state: 'visible' });
      expect((await writesOf('PATCH /v1/warden/config')).length, 'a pick writes nothing').toBe(0);
      expect(await wardenPage.locator('a[href*="speedups"]').count(), 'no road into Settings').toBe(0);
      expect(
        await wardenPage.locator('[data-warden-key-row] [data-panel="voice.speedup-key"]').count(),
        'the key row is the registered Voice panel',
      ).toBe(1);
      await tab.waitForTimeout(1_800);
      const budget = await wardenPage.evaluate(page => {
        const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
        const body = page.querySelector('.wd-step') as HTMLElement;
        const row = body.querySelector('[data-warden-key-row]') as HTMLElement;
        return { all: flat(body.innerText), row: flat(row.innerText) };
      });
      console.log(
        `warden page text with the key row (${budget.all.length} chars): ${budget.all} | key row alone (${budget.row.length} chars)`,
      );
      expect(budget.all, 'no raw URL anywhere on the page, key row included').not.toMatch(/https?:|www\.|\.com|\.test/);
      expect(budget.all.length, 'the stated 160-character budget, key row and card titles counted').toBeLessThanOrEqual(
        160,
      );
      await shot(tab, variant, 'warden.warden-jev-empty');
      const FAKE_KEY = 'jev-fake-key-0123456789abcdef';
      await field.fill(FAKE_KEY);
      await wardenPage.getByRole('button', { name: 'Save' }).click();
      await wardenPage.locator('[data-speedup-set]').waitFor({ state: 'visible' });
      expect(await writesOf('POST /v1/secrets'), 'the exact vault write, once').toEqual([
        { route: 'POST /v1/secrets', body: { name: 'JEV_API_KEY', value: FAKE_KEY } },
      ]);
      const where = await tab.evaluate(key => {
        const stores = [localStorage, sessionStorage].map(store => JSON.stringify({ ...store }));
        return {
          html: document.documentElement.outerHTML.includes(key),
          text: document.body.innerText.includes(key),
          stores: stores.some(store => store.includes(key)),
          fields: [...document.querySelectorAll('input,textarea')].some(el =>
            (el as HTMLInputElement).value.includes(key),
          ),
        };
      }, FAKE_KEY);
      expect(where, 'the key is in no DOM, field or storage').toEqual({
        html: false,
        text: false,
        stores: false,
        fields: false,
      });
      expect(
        consoleLines.some(line => line.includes(FAKE_KEY)),
        'the key is in no console line',
      ).toBe(false);
      await shot(tab, variant, 'warden.warden-jev-saved');
      await wardenPage.getByRole('button', { name: 'Test the Jev key' }).click();
      await wardenPage.locator('[data-speedup-last-test]').waitFor({ state: 'visible' });
      expect(
        (await daemonOf(tab, A)).mutations.filter(m => m.route === 'POST /v1/speedups/jev/test').length,
        'Test is one provider call',
      ).toBe(1);
      await tab.waitForFunction(() => !(document.querySelector('[data-step-next]') as HTMLButtonElement).disabled);
      await next(tab, 'lessons.lessons');
      expect(await writesOf('PATCH /v1/warden/config'), 'Next is ONE write of warden.yaml, naming the key').toEqual([
        {
          route: 'PATCH /v1/warden/config',
          body: { enabled: true, layers: { jev: true, llm: false }, nameJevKey: true },
        },
      ]);
      expect((await daemonOf(tab, A)).mutations.filter(m => m.route === 'POST /v1/warden/jev-key').length).toBe(0);
      expect(
        consoleLines.some(line => line.includes(FAKE_KEY)),
        'the key is in no console line after Next either',
      ).toBe(false);
      expect(await recorded(tab, A, 'warden.warden')).toBe('done');
      await answerWithNext(tab, variant, A, 'lessons.lessons', 'onboarding.appearance', { before: 'warden.warden' });
      // Shells is never on screen: nix is found, so the page skipped itself and the machine recorded it.
      expect(walked.includes('shells.nix'), 'Shells is skipped when nix is found').toBe(false);
      expect(await recorded(tab, A, 'shells.nix'), 'Shells recorded as found or skipped').toMatch(/found|skipped/u);

      // ── This device: Appearance, Layout, Voice ──────────────────────────────────────────────────────────────────
      await reach(tab, 'onboarding.appearance');
      walked.push('onboarding.appearance');
      await inspect(tab, variant, 'onboarding.appearance');
      await shot(tab, variant, 'onboarding.appearance');
      const appearanceBefore = (await daemonOf(tab, A)).mutations.length;
      await tab.locator('input[type="radio"]:checked').first().focus();
      await tab.keyboard.press('ArrowRight');
      await tab.waitForTimeout(300);
      expect((await daemonOf(tab, A)).mutations.length, 'an arrow key on Appearance wrote nothing to the machine').toBe(
        appearanceBefore,
      );
      expect(await ledgerOf(tab), 'nothing is on the device ledger before Next').toEqual({});
      // Enter chooses the focused style; put the style back, so the pages after it are shot in the look the person had.
      await tab.keyboard.press('Enter');
      await tab.keyboard.press('ArrowLeft');
      await tab.keyboard.press('Enter');
      await tab.waitForTimeout(300);
      await next(tab, 'layouts.layout');
      expect(Object.keys(await ledgerOf(tab)), 'Appearance is on the device ledger after Next').toContain(
        'onboarding.appearance',
      );

      await reach(tab, 'layouts.layout');
      walked.push('layouts.layout');
      await inspect(tab, variant, 'layouts.layout');
      await shot(tab, variant, 'layouts.layout');
      await next(tab, 'voice.voice');
      expect(Object.keys(await ledgerOf(tab))).toContain('layouts.layout');

      await reach(tab, 'voice.voice');
      walked.push('voice.voice');
      await inspect(tab, variant, 'voice.voice');
      // Voice: every Install button is 44px tall, and no engine card clips its own text (a card hides overflow).
      const installs = await tab
        .locator('.fy-engine-card button.fy-engine-mini')
        .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height * 10) / 10));
      expect(installs.length, 'Voice: at least one Install button').toBeGreaterThan(0);
      for (const height of installs)
        expect(height, 'Voice: an Install button is 44px tall').toBeGreaterThanOrEqual(43.5);
      await shot(tab, variant, 'voice.voice');
      await tab.getByRole('button', { name: 'Show every engine' }).click();
      // The Off card, on its own, so its whole text can be read in the picture (the page shot scrolls past it).
      const off = tab.locator('.fy-engine-card[data-engine="off"]');
      // Centred, so the footer bar does not sit over its lower half in the picture.
      await off.evaluate(node => node.scrollIntoView({ block: 'center' }));
      expect(await off.innerText(), 'Voice: the Off card shows its whole text').toContain('Settings › Voice.');
      if (shotsDir !== '') await off.screenshot({ path: join(shotsDir, `${variant.name}-voice-off-card.png`) });
      const clipped = await tab
        .locator('.fy-engine-card')
        .evaluateAll(nodes =>
          nodes
            .filter(node => node.scrollHeight > node.clientHeight)
            .map(node => (node as HTMLElement).dataset.engine ?? ''),
        );
      expect(clipped, 'Voice: no engine card clips its text').toEqual([]);
      await shot(tab, variant, 'voice.voice-all-engines');
      await next(tab, 'end');
      expect(Object.keys(await ledgerOf(tab))).toContain('voice.voice');

      // ── ONE counter model for the whole run (item 1) ──
      const run = countersOf(variant);
      expect(
        new Set(run.map(counter => counter.bar)).size,
        `the bar has the same number of segments on every page (${run.map(counter => counter.bar).join(',')})`,
      ).toBe(1);
      for (const plugin of ['codex', 'warden', 'lessons'])
        expect(
          new Set(run.filter(counter => counter.key.startsWith(`${plugin}.`)).map(counter => counter.of)).size,
          `${plugin}: n never changes while its answers stand`,
        ).toBe(1);
      expect(
        run.filter(counter => counter.key.startsWith('codex.')).map(counter => [counter.n, counter.of]),
        'Codex: Import everything reads page 1 of 4 on its first page and walks 1, 2, 3, 4',
      ).toEqual([
        [1, 4],
        [2, 4],
        [3, 4],
        [4, 4],
      ]);
      expect(
        new Set(
          run
            .filter(counter => counter.key.startsWith('claude-code.') && counter.key !== 'claude-code.import-choice')
            .map(counter => counter.of),
        ).size,
        'Claude: after Choose is picked n stays 9 on every later page',
      ).toBe(1);
      expect(
        run
          .filter(counter => ['onboarding.appearance', 'layouts.layout', 'voice.voice'].includes(counter.key))
          .map(counter => [counter.n, counter.of]),
        'This device: pages 1, 2, 3 of 3',
      ).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ]);

      // ── the end page ────────────────────────────────────────────────────────────────────────────────────────────
      expect(await tab.locator(CHROME).count(), 'the end page has no app chrome').toBe(0);
      expect(await tab.locator('[data-flow-unsaved]').count(), 'the end page lists no unsaved answer').toBe(0);
      // The end page says what was set up in a sentence: no raw dump of page titles or ids.
      const summary = await tab.locator('[data-onboarding-summary]').innerText();
      expect(summary, 'the end page has the machine checklist').toMatch(/^this machine\s/iu); // innerText reads the heading's small caps as capitals;
      for (const raw of ['What to bring over', 'Bring it over', 'import-choice', 'claude-code.', 'Conversations'])
        expect(summary, `the end page does not list the page title '${raw}'`).not.toContain(raw);
      // One row per segment, each with a drawn mark; a segment left for later says so quietly and links to its Settings.
      const rows = await tab.locator('[data-onboarding-summary] [data-end-row]').count();
      expect(rows, 'the end page has one row per segment').toBeGreaterThanOrEqual(2);
      expect(await tab.locator('[data-onboarding-summary] [data-end-row] svg').count(), 'every row has a mark').toBe(
        rows,
      );
      expect(
        await tab.locator('[data-onboarding-summary] [data-end-state="later"]').count(),
        'every skipped row has a link to finish it',
      ).toBe(
        await tab.locator('[data-onboarding-summary] [data-end-state="later"] [data-onboarding-later-link]').count(),
      );
      expect(summary, 'the end page does not say "(some pages skipped)"').not.toContain('some pages skipped');
      expect(summary.length, 'the end page summary is short').toBeLessThanOrEqual(300);
      for (const height of await tab
        .locator('[data-flow-end] button')
        .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)))
        expect(height, 'the end page buttons are 44px tall').toBeGreaterThanOrEqual(43.5);
      expect(await tab.locator('[data-flow-end]').count()).toBe(1);
      await endPage(tab, variant, 'end');
      await shot(tab, variant, 'end');
      // Every machine step ended up answered, each exactly once.
      const done = await daemonOf(tab, A);
      for (const step of MACHINE_A.steps.filter(candidate => candidate.side === undefined)) {
        const key = `${step.plugin}.${step.id}`;
        expect(done.states[key], `${key} was answered on the machine`).toBeDefined();
        expect(
          done.answers.filter(answer => answer.plugin === step.plugin && answer.id === step.id).length,
          `${key} was answered exactly once`,
        ).toBe(1);
      }
      expect(walked, 'the first-run pages, in order').toEqual(
        expect.arrayContaining([
          'onboarding.name',
          'claude-code.import-choice',
          'claude-code.import-settings',
          'claude-code.import-skills',
          'claude-code.import-run',
          'claude-code.permission',
          'codex.import-choice',
          'warden.warden',
          'lessons.lessons',
          'onboarding.appearance',
          'layouts.layout',
          'voice.voice',
        ]),
      );
      for (const never of [
        'claude-code.installed',
        'claude-code.sign-in',
        'codex.installed',
        'codex.sign-in',
        'shells.nix',
      ])
        expect(walked.includes(never), `${never} is never drawn on a machine that has it`).toBe(false);
      // Nothing is "Only on" yet: one machine carries every step.
      expect(await tab.locator('[data-only-on]').count()).toBe(0);

      // ── a SECOND machine: the Pair journey from inside the app ─────────────────────────────────────────────────
      await navigate('/onboarding?journey=pair');
      await tab.waitForSelector('[data-onboarding-open-pair]');
      await measureButton(tab, variant, 'Open the pairing page', '[data-onboarding-open-pair]');
      expect(await tab.locator(CHROME).count(), 'the Pair start has no app chrome').toBe(0);
      await shot(tab, variant, 'pair-journey');
      await tab.locator('[data-onboarding-open-pair]').click();
      await tab.getByText('Paste a link').click();
      await tab.getByLabel('Pairing link').fill(pairLinkOf(MACHINE_B, origin));
      await tab.getByText('Use this link').click();
      await tab.locator('[data-pair-confirm]').waitFor();
      await tab.locator('[data-pair-confirm]').click();
      // This machine has no passkey and its first window is open, so the pairing page offers one before it returns.
      await tab.locator('[data-first-passkey-offer]').waitFor();
      seen.pairConnectedChrome = await tab.locator(CHROME).count();
      await shot(tab, variant, 'pair-connected-passkey-offer');
      await tab.getByRole('button', { name: 'Not now' }).click();
      await tab.waitForURL(/\/onboarding\/setup\?phase=client&journey=pair/u);
      // What this device already set (Appearance, Layout, Voice) is skipped; what only the new machine carries is asked.
      await reach(tab, 'access.passkey');
      walked.push('access.passkey');
      expect(await tab.locator('[data-only-on]').textContent(), 'the chip names the machine').toBe(
        `Only on ${MACHINE_B.name}`,
      );
      await inspect(tab, variant, 'access.passkey', { first: true });
      await shot(tab, variant, 'access.passkey-chip');
      await next(tab, 'end');
      expect(Object.keys(await ledgerOf(tab))).toContain('access.passkey');
      expect((await ledgerOf(tab))['access.passkey']?.daemons, 'the passkey answer is for the new machine').toEqual([
        B,
      ]);
      await shot(tab, variant, 'end-pair');
      await endPage(tab, variant, 'end-pair');
      // The Pair journey's ending has the same summary: what this device now holds, and where to change it.
      const pairSummary = await tab.locator('[data-onboarding-summary]').innerText();
      expect(pairSummary, 'end-pair: the summary says what was set up on this device').toMatch(/this device\s/iu);
      expect(pairSummary, 'end-pair: the summary names the Passkey page').toContain('Passkey');
      expect(pairSummary, 'end-pair: the summary says where to change it').toMatch(/Settings/u);
      const second = await daemonOf(tab, B);
      expect(second.answers, 'a Pair journey answers nothing on the new machine (it is not being set up)').toEqual([]);
      expect(
        walked.filter(key => ['onboarding.appearance', 'layouts.layout', 'voice.voice'].includes(key)),
      ).toHaveLength(3);
      // Each client page was asked once in the whole journey: the Pair journey did not ask them again.
      expect(walked.filter(key => key === 'onboarding.appearance')).toHaveLength(1);

      if (shotsDir !== '')
        await Bun.write(join(shotsDir, `${variant.name}-counters.txt`), `${seen.counters.join('\n')}\n`);
      seen.counters.length = 0;
      seen.unanswered = [...(await daemonOf(tab, A)).unanswered, ...(await daemonOf(tab, B)).unanswered];
      await context.close();
    });
});

// ─── what the run found (each gap was `it.failing` until it was fixed; now each is a plain test) ───────────────────────
describe('the gaps the gate found, now closed', () => {
  it('no page threw', () => {
    expect(seen.pageErrors).toEqual([]);
  });
  it('only the expected routes went unanswered (a gap in the fake, not in the product)', () => {
    expect([...new Set(seen.unanswered)].sort()).toEqual(['GET /v1/layouts/current']);
  });
  it('the Machine name page draws ONE name form (the shell strip draws a second above the flow)', () => {
    expect(seen.nameForms).toBe(1);
  });
  // Only a desktop height shows it (a phone's footer is sticky), so it is asserted only when a desktop variant ran.
  (VARIANTS.some(variant => variant.width >= 600) ? it : it.skip)(
    'every page keeps its Back/Next footer on the first screen (no scrolling to reach Next)',
    () => {
      expect(seen.footerOffScreen).toEqual([]);
    },
  );
  it('the pairing page buttons are auto width and 44px tall', () => {
    expect(seen.badButtons).toEqual([]);
  });
  it('the pairing page reached from the first run has no sidebar or app chrome', () => {
    expect(seen.pairPageChrome).toBe(0);
  });
  it('the pairing page Connected screen has no sidebar or app chrome', () => {
    expect(seen.pairConnectedChrome).toBe(0);
  });
  it('Import everything is ONE page for Codex (the kind pages are passed over, not drawn)', () => {
    expect(seen.codexKindPagesInEverything).toBe(0);
  });
  it('the fixed fake code is the only code used', () => {
    expect(FAKE_CODE).toBe('ABCD-EFGH');
  });
});
