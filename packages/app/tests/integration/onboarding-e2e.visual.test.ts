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
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { LOADING_DELAY_MS, LOADING_FADE_MS, LOADING_MIN_MS } from '../../src/ui/loading-gate.ts';
import {
  arrowWalkRings,
  edgeRings,
  NEXT_SPINNER_LOG,
  type NextSpinnerRun,
  sceneServer,
  sharedChromium,
  walkFocusRings,
} from '../support/browser/index.ts';
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
  /** r11-1b G6: every step cover that drew its loader in a journey with `latency` ms answers: how long the loader stayed. */
  covers: { latency: number; variant: string; ms: number; fullMs: number; gapMs: number }[];
  /** r11-1c C3: every time the Next button's busy spinner was VISIBLE in a journey: how long, and how long fully shown. */
  nextSpinners: { latency: number; variant: string; ms: number; fullMs: number; gapMs: number }[];
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
  covers: [],
  nextSpinners: [],
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
      { timeout: loadAware(15_000, IDLE_FRAME_MS) },
    );
  } catch {
    throw new Error(`expected the flow on ${key} but it is on ${await keyOf(tab)}`);
  }
  // The slide-in finishes before anything is measured or shot.
  await tab.waitForTimeout(350);
};

/** Every Next press: where it was, where it went and how long (page clock) until the target was ready. */
const moves: { from: string; to: string; ms: number; latency: number; frameMs: number }[] = [];
/**
 * LOAD-AWARE TIME BOUNDS (end B5). A fixed bound of N ms is a bound of N ms on an idle machine only: under load 50-70 the same
 * work takes several times as long and the test flaked red with nothing wrong in the product (a Next press measured 152 ms against
 * 150 at load 44, while the page's frames still read an idle 16.7 ms). So each bound is stated at idle and scales with the larger of
 * two measured slow-downs: the page's own median animation-frame interval (measured just before the act) over an idle frame, and the
 * host's load (the larger of the one-minute average and the runnable count of the last ten seconds) over its core count (twice, see `LOAD_MARGIN`). It is never tighter than the idle bound.
 */
const IDLE_FRAME_MS = 1_000 / 60;
/** The one-minute load average lags and time-slicing costs more than the ratio (a press took 2.6x its idle time at a load ratio of 2.1). */
const LOAD_MARGIN = 2;
const frameBaseline = async (tab: Page): Promise<number> =>
  await tab.evaluate(
    () =>
      new Promise<number>(done => {
        const stamps: number[] = [];
        const tick = (now: number): void => {
          stamps.push(now);
          if (stamps.length < 14) requestAnimationFrame(tick);
          else {
            const gaps = stamps
              .slice(1)
              .map((stamp, index) => stamp - (stamps[index] as number))
              .sort((a, b) => a - b);
            done(gaps[Math.floor(gaps.length / 2)] as number);
          }
        };
        requestAnimationFrame(tick);
      }),
  );
/**
 * The host's runnable-task count NOW (Linux: the fourth field of /proc/loadavg), because the one-minute average lags a burst by
 * minutes: a run that started at load 13 saw a Next press take 260 ms once other work arrived. Elsewhere the one-minute load stands in.
 */
const runnableNow = (): number => {
  try {
    return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[3]?.split('/')[0]);
  } catch {
    return loadavg()[0] ?? 0;
  }
};
const recentRunnable: number[] = [];
const sampler = setInterval(() => {
  recentRunnable.push(runnableNow());
  if (recentRunnable.length > 20) recentRunnable.shift();
}, 500);
sampler.unref();
/** The host's slow-down: the larger of its one-minute load and the mean runnable count of the last ten seconds, over its core count. */
const hostSlowdown = (): number => {
  const recent =
    recentRunnable.length === 0 ? 0 : recentRunnable.reduce((sum, count) => sum + count, 0) / recentRunnable.length;
  return Math.max(loadavg()[0] ?? 0, recent) / cpus().length;
};
const loadAware = (idleMs: number, frameMs: number): number =>
  Math.round(idleMs * Math.max(1, frameMs / IDLE_FRAME_MS, LOAD_MARGIN * hostSlowdown()));
/** The answer delay of the journey being walked: 0 (the machines answer at once) or the slow run's 100 ms (r11-1b G6). */
let latencyNow = 0;
/**
 * What the step cover's loader must show (r11-1b G6), from the code's own constants (`useHeldLoading`, `delay: 0` because the
 * cover's own 300 ms already waited), so the bounds move with them: on screen (opacity above 0) for the fade plus the minimum,
 * and fully shown (opacity 1) for the minimum. The first frame of each is SAMPLED, not announced, so a loaded machine's late
 * frames are given six frames of slack; a blink on base was 50-183 ms, far under either bound.
 */
const SAMPLE_SLACK_FRAMES = 6;
/**
 * LOAD-INDEPENDENT HOLD BOUNDS (end B5 review). The hold is a page timer and the page samples it from its own animation frames,
 * so the only thing load can change is how LATE a frame sampled the loader: and the sampler measures that itself (`gapMs`, the
 * widest gap between two of its frames while the loader was there). The slack is six of those frames (six idle frames = 100 ms,
 * what the gate always allowed at idle), never more than a quarter of what the code promises. The HOST's load never enters:
 * widening by it let a 126.5 ms blink and a loader that never reached full opacity pass at load 60 on 32 cores. The floor
 * (three quarters of each promise: 345 ms on screen, 225 ms fully shown) stays far above the 126.5 ms blink.
 */
const SLACK_SHARE = 0.25;
const slackOf = (gapMs: number, promisedMs: number): number =>
  Math.min(SAMPLE_SLACK_FRAMES * Math.max(gapMs, IDLE_FRAME_MS), promisedMs * SLACK_SHARE);
const coverOnScreenAtLeast = (gapMs: number): number =>
  LOADING_FADE_MS + LOADING_MIN_MS - slackOf(gapMs, LOADING_FADE_MS + LOADING_MIN_MS);
const coverFullAtLeast = (gapMs: number): number => LOADING_MIN_MS - slackOf(gapMs, LOADING_MIN_MS);
/** What a held loader got wrong (empty: it stayed for its promise). */
const holdShortfalls = (held: { ms: number; fullMs: number; gapMs: number }): string[] => [
  ...(held.ms >= coverOnScreenAtLeast(held.gapMs)
    ? []
    : [`on screen ${held.ms} ms, under ${Math.round(coverOnScreenAtLeast(held.gapMs))}`]),
  ...(held.fullMs >= coverFullAtLeast(held.gapMs)
    ? []
    : [`fully shown ${held.fullMs} ms, under ${Math.round(coverFullAtLeast(held.gapMs))}`]),
];
/**
 * The ready-time limit of a move onto a page that was drawn in advance: 150 ms at idle, widened by the page's own frames and by the
 * host's slow-down (a press measured 152 ms at load 44), but NEVER to or past LOADING_DELAY_MS: a move that was not preloaded waits
 * out that React hold (300 ms) and then does its work, so it takes at least that long at any load (416 ms at the gate), and a limit
 * of 563 ms at load 60 on 32 cores accepted it.
 */
const moveReadyLimit = (frameMs: number, slowdown: number): number =>
  Math.min(Math.round(150 * Math.max(1, frameMs / IDLE_FRAME_MS, LOAD_MARGIN * slowdown)), LOADING_DELAY_MS - 1);
/**
 * Every step-cover loader of a journey, and how long it was ON SCREEN: from the first frame its computed opacity is above 0 to
 * the moment it leaves the document (a frame loop samples the opacity; a MutationObserver stamps the removal). A loader that
 * leaves before any frame saw it is 0 ms: it blinked.
 */
const COVER_LOG = `
  window.__covers = [];
  let shownAt = -1;
  let fullAt = -1;
  let there = false;
  const loader = () => document.querySelector('[data-flow-cover] [data-loading]');
  let lastFrame = -1;
  let widestGap = 0;
  const sample = () => {
    const node = loader();
    if (node === null) return;
    const now = performance.now();
    widestGap = Math.max(widestGap, now - lastFrame);
    lastFrame = now;
    const opacity = Number.parseFloat(getComputedStyle(node).opacity);
    if (shownAt < 0 && opacity > 0) shownAt = now;
    if (fullAt < 0 && opacity >= 0.99) fullAt = now;
    requestAnimationFrame(sample);
  };
  new MutationObserver(() => {
    const now = loader() !== null;
    if (now && !there) {
      lastFrame = performance.now();
      widestGap = 0;
      requestAnimationFrame(sample);
    }
    if (!now && there) {
      const end = performance.now();
      window.__covers.push({
        ms: shownAt < 0 ? 0 : end - shownAt,
        fullMs: fullAt < 0 ? 0 : end - fullAt,
        gapMs: widestGap,
      });
      shownAt = -1;
      fullAt = -1;
    }
    there = now;
  }).observe(document, { childList: true, subtree: true });
`;

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
  // (Back · Later · Next), never a link floating in the page. Measured from `.fy-spf__main` (demo + body): on a phone the
  // populated demo panel is drawn ABOVE the body, so the body alone would count the demo's height as dead space.
  const gap = await gapUnderTitle(tab, '.fy-spf__head', '.fy-spf__main');
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
    .locator('[data-onboarding-channel], [data-onboarding-actions] button')
    .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height * 10) / 10));
  // A button that offers something (the OS choices) has a border: never a plain text line in a sentence.
  for (const borderless of await tab
    .locator('[data-onboarding-channel]')
    .evaluateAll(nodes =>
      nodes
        .filter(node => Number.parseFloat(getComputedStyle(node).borderTopWidth) === 0)
        .map(node => (node.textContent ?? '').trim()),
    ))
    expect(borderless, `${key}: a choice or offer without a border`).toBe('');
  for (const height of heights)
    expect(height, `${key}: every choice and footer button is 44px tall`).toBeGreaterThanOrEqual(43.5);
};

/**
 * Collects a pairing button of the wrong shape (read by the gap below, not asserted here): on a phone it is FULL width,
 * at least 0.9 of the page's content width (its `<main>` minus padding, not its action row's), and its `answers` action-row
 * answers are STACKED one under another (the owner's words, since #2296); on a desktop it is under half the page width.
 * Either way it is at least 44px tall, and a button, page or row that cannot be measured is collected as a failure.
 */
const measureButton = async (
  tab: Page,
  variant: Variant,
  label: string,
  selector: string,
  answers: number,
): Promise<void> => {
  const measured = await tab
    .locator(selector)
    .first()
    .evaluate((node, expected) => {
      const box = node.getBoundingClientRect();
      // The STABLE page content width: the page's own <main> minus its padding. The button's parent (the action row) is
      // never the reference, because a row that shrank with its button would make a half-width button look "full width".
      const page = node.closest('main');
      const style = page === null ? null : getComputedStyle(page);
      const content =
        page === null || style === null
          ? Number.NaN
          : page.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      // Every answer of the button's action row, with its place on the glass (the button itself included).
      const row = node.closest('[data-action-row]');
      const rects = [...(row?.children ?? [])].map(child => {
        const rect = child.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      });
      const sorted = [...rects].sort((a, b) => a.top - b.top);
      // Stacked: each answer starts at or below the bottom of the one above it (a 0.5px rounding allowance) and none is
      // beside another, so no two share a horizontal band.
      const stacked = sorted.every((rect, index) => index === 0 || rect.top >= (sorted[index - 1]?.bottom ?? 0) - 0.5);
      return { width: box.width, height: box.height, content, answers: rects.length, stacked, expected };
    }, answers)
    .catch(() => null);
  const name = `${variant.name}:${label}`;
  if (measured === null || !Number.isFinite(measured.content) || measured.content <= 0) {
    // An absent measurement is a failure, never a pass: no element, no page <main>, or a zero-width page.
    seen.badButtons.push(`${name} (could not be measured)`);
    return;
  }
  const phone = variant.width < 600;
  const wrongWidth = phone ? measured.width < 0.9 * measured.content : measured.width >= 0.5 * variant.width;
  const notStacked = phone && (measured.answers !== measured.expected || !measured.stacked);
  if (wrongWidth || notStacked || measured.height < 44)
    seen.badButtons.push(
      `${name} (${Math.round(measured.width * 100) / 100}x${Math.round(measured.height * 100) / 100} of ${Math.round(measured.content)} content, ${measured.answers} answers ${measured.stacked ? 'stacked' : 'side by side'})`,
    );
};

/** Presses Next and waits for `to` (a page key, or `end`). */
const next = async (tab: Page, to: string): Promise<void> => {
  const from = await keyOf(tab);
  const frameMs = await frameBaseline(tab);
  // The press is stamped IN the browser (pointerdown, page clock): Playwright's own scroll/stability checks before the click
  // (up to ~100 ms on a phone) are not the app's time.
  await tab.evaluate(() => {
    const mine = window as unknown as { __pressedAt: number; __pressHook?: true };
    mine.__pressedAt = Number.NaN;
    if (mine.__pressHook === undefined) {
      mine.__pressHook = true;
      document.addEventListener(
        'pointerdown',
        event => {
          if (event.target instanceof Element && event.target.closest('[data-step-next]') !== null)
            mine.__pressedAt = performance.now();
        },
        true,
      );
    }
  });
  await tab.locator('[data-step-next]').click();
  const began = await tab.evaluate(() => (window as unknown as { __pressedAt: number }).__pressedAt);
  // The frame the page is READY in (the cover is down and the page said so), read in the page's own clock.
  const readyAt = await tab
    .waitForFunction(
      wanted => {
        if (wanted === 'end') return document.querySelector('[data-flow-end]') !== null ? performance.now() : false;
        const page = document.querySelector('[data-flow-page]');
        return page?.getAttribute('data-flow-page') === wanted && page.hasAttribute('data-ready')
          ? performance.now()
          : false;
      },
      to,
      { timeout: loadAware(15_000, IDLE_FRAME_MS) },
    )
    .then(handle => handle.jsonValue())
    .catch(() => Number.NaN);
  moves.push({ from, to, ms: Math.round((readyAt as number) - began), latency: latencyNow, frameMs });
  await reach(tab, to);
};

/** Back then Next: Back lands on the page the person came from and Next comes straight back. */
const backAndForth = async (tab: Page, from: string, key: string): Promise<void> => {
  await tab.locator('[data-step-back]').click();
  await reach(tab, from);
  await next(tab, key);
};

/** The runtime-import proposals the machine has been sent so far: an import that was asked for makes one, Later makes none. */
const proposalsOf = async (tab: Page, daemon: string): Promise<number> =>
  (await daemonOf(tab, daemon)).mutations.filter(mutation => mutation.route === 'POST /v1/runtimes/proposals').length;

/**
 * Later on an import page: the flow goes on to another page, and the machine was sent NO import proposal (leaving an import
 * for later imports nothing). Then Back to the page, so the walk below carries on from where it was.
 */
const laterThenBack = async (tab: Page, daemon: string, key: string): Promise<void> => {
  const proposals = await proposalsOf(tab, daemon);
  await tab.locator('[data-step-later]').click();
  await tab.waitForFunction(
    from => document.querySelector('[data-flow-page]')?.getAttribute('data-flow-page') !== from,
    key,
    { timeout: 8_000 },
  );
  const landed = await keyOf(tab);
  expect(landed, `${key}: Later left the page`).not.toBe(key);
  expect(await proposalsOf(tab, daemon), `${key}: Later sent no import proposal`).toBe(proposals);
  for (let steps = 0; (await keyOf(tab)) !== key && steps < 12; steps += 1) {
    await tab.locator('[data-step-back]').click();
    await tab.waitForTimeout(500);
  }
  await reach(tab, key);
  expect(await proposalsOf(tab, daemon), `${key}: coming back sent no import proposal either`).toBe(proposals);
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
  const final = view.states[key] as string;
  // A page left with Later and answered by Next afterwards carries both answers (Later, then done); the FINAL answer is never written twice.
  expect(
    view.answers.filter(answer => answer.plugin === plugin && answer.id === id && answer.state === final).length,
    `${key}: its final answer reached the machine exactly once`,
  ).toBe(1);
  return final;
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
  // Measured from `.fy-spf__main` (picture + body): on a phone the picture (the ferret) is drawn ABOVE the body, like every demo.
  const gap = await gapUnderTitle(tab, '.fy-spf__head', '.fy-spf__main');
  expect(gap.gap, `${key}: no dead gap under the title`).toBeLessThanOrEqual(40);
};

/** What the mascot asserts measured (printed with FY_ONBOARDING_E2E_SHOTS_DIR). */
const mascotMeasured: string[] = [];

/**
 * r11-1b G1 (gate line 12): right after a page hands over to the End page the "You're set up" heading is fully on screen
 * and nothing that holds it has kept the previous page's scroll (Voice with every engine shown is long; its scroll used to
 * carry over and draw the heading at y=-147).
 */
const endHeadingInView = async (tab: Page, variant: Variant, key: string): Promise<void> => {
  const read = await tab.evaluate(() => {
    const heading = document.querySelector('.fy-spf__title');
    const box = heading?.getBoundingClientRect();
    const scrolled: string[] = [];
    for (let el = heading?.parentElement ?? null; el !== null; el = el.parentElement)
      if (el.scrollTop > 0) scrolled.push(`${el.tagName.toLowerCase()}.${el.className}: ${el.scrollTop}px`);
    return { top: box?.top ?? Number.NaN, bottom: box?.bottom ?? Number.NaN, height: window.innerHeight, scrolled };
  });
  // The picture the person sees on arrival (the window, not the whole page): the heading must be in it.
  if (shotsDir !== '')
    await tab.screenshot({
      path: join(shotsDir, `${variant.name}-end-arrival-${key.replaceAll(' ', '').replaceAll('>', '')}.png`),
    });
  mascotMeasured.push(
    `${variant.name}:${key}: End heading top ${read.top.toFixed(1)} bottom ${read.bottom.toFixed(1)} of ${read.height}; scrolled ancestors [${read.scrolled.join(', ')}]`,
  );
  expect(read.scrolled, `${key}: no ancestor of the End heading keeps the last page's scroll`).toEqual([]);
  expect(read.top, `${key}: the "You're set up" heading starts on screen (top ${read.top})`).toBeGreaterThanOrEqual(0);
  expect(read.bottom, `${key}: the heading ends above the fold (bottom ${read.bottom})`).toBeLessThanOrEqual(
    read.height,
  );
};

/** The slot the End page draws its picture from, and the ferret Access places in it. */
const END_SLOT = '.fy-slot[data-slot="onboarding.end"]';

/** Running CSS animations that belong to the ferret, as `<name>@<marker>`. */
const ferretAnimations = async (tab: Page): Promise<string[]> =>
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

/** Where the pupils look (translation of the look layer, SVG units) once any transition has finished. */
const pupilLook = async (tab: Page): Promise<{ x: number; y: number }> =>
  await tab.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(animation => animation instanceof CSSTransition)
        .map(animation => animation.finished),
    );
    const node = document.querySelector('[data-end-mascot] [data-mascot-look]');
    if (node === null) return { x: Number.NaN, y: Number.NaN };
    const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    return { x: matrix.e, y: matrix.f };
  });

/**
 * r11-1b G1 (gate line 2), in the REAL shell: the End page's picture is exactly Access's `access.end-mascot` panel in the
 * `onboarding.end` slot; hovering (a mouse) or tapping (a phone) it moves the pupils and starts the wave within 400 ms;
 * under reduced motion only the blink runs; it never takes focus.
 */
const endMascot = async (tab: Page, variant: Variant, key: string): Promise<void> => {
  const phone = variant.width < 600;
  expect(
    await tab
      .locator(`${END_SLOT} [data-panel]`)
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-panel'))),
    `${key}: the slot holds exactly Access's end-mascot panel`,
  ).toEqual(['access.end-mascot']);
  const ferret = tab.locator(`${END_SLOT} .fy-ferret[data-pose="cheer"]`);
  expect(await ferret.count(), `${key}: the panel draws the cheering ferret`).toBe(1);
  await ferret.evaluate(node => node.scrollIntoView({ block: 'center' }));
  await tab.waitForTimeout(100);
  const box = (await ferret.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  expect(box.width, `${key}: the ferret has a size`).toBeGreaterThan(40);
  if (!phone)
    expect(box.x, `${key}: on a desktop the ferret is in the right half (x ${box.x})`).toBeGreaterThanOrEqual(
      variant.width / 2 - 1,
    );
  // The pointer starts far from the ferret, so the move below is what the pupils answer.
  await tab.mouse.move(2, 2);
  await tab.waitForTimeout(200);
  const rest = await pupilLook(tab);
  expect(rest, `${key}: at rest the pupils look straight ahead`).toEqual({ x: 0, y: 0 });
  const aim = { x: box.x + box.width * 0.9, y: box.y + box.height * 0.5 };
  const waveBudget = loadAware(400, await frameBaseline(tab));
  const started = Date.now();
  if (phone) await tab.touchscreen.tap(aim.x, aim.y);
  else await tab.mouse.move(aim.x, aim.y);
  await tab.waitForFunction(
    () =>
      document
        .querySelector('[data-end-mascot] [data-mascot-wave]')
        ?.getAnimations()
        .some(
          animation =>
            animation instanceof CSSAnimation &&
            animation.animationName === 'fy-ferret-wave-again' &&
            animation.playState === 'running',
        ) === true,
    undefined,
    { timeout: waveBudget },
  );
  const waveMs = Date.now() - started;
  expect(
    waveMs,
    `${key}: the wave runs within ${waveBudget} ms (400 ms at idle frames) of the ${phone ? 'tap' : 'hover'} (${waveMs} ms)`,
  ).toBeLessThanOrEqual(waveBudget);
  const looked = await pupilLook(tab);
  expect(looked.x, `${key}: the pupils moved toward the pointer (x ${looked.x.toFixed(2)})`).toBeGreaterThan(1);
  expect(Math.abs(looked.x), `${key}: and stay inside the eye`).toBeLessThanOrEqual(3.3);
  expect(
    await tab.evaluate(() => document.activeElement?.closest('[data-end-mascot]') != null),
    `${key}: the ferret never takes focus`,
  ).toBe(false);
  expect(
    await tab.locator(`${END_SLOT} :is(a, button, input, select, textarea, [tabindex])`).count(),
    `${key}: nothing in the picture can be focused or clicked`,
  ).toBe(0);
  mascotMeasured.push(
    `${variant.name}:${key}: wave after ${waveMs} ms; pupils ${looked.x.toFixed(2)},${looked.y.toFixed(2)}`,
  );
  // Let the poke settle, then ask for reduced motion: a hover or tap moves nothing but the blink.
  await tab.waitForFunction(
    () => document.querySelector('[data-end-mascot] .fy-ferret[data-poke]') === null,
    undefined,
    {
      timeout: 4_000,
    },
  );
  await tab.emulateMedia({ reducedMotion: 'reduce' });
  await tab.mouse.move(2, 2);
  await tab.waitForTimeout(150);
  if (phone) await tab.touchscreen.tap(aim.x, aim.y);
  else await tab.mouse.move(aim.x, aim.y);
  await tab.waitForTimeout(200);
  const moving = (await ferretAnimations(tab)).filter(name => !name.endsWith('@data-mascot-blink'));
  await tab.emulateMedia({ reducedMotion: 'no-preference' });
  expect(moving, `${key}: under reduced motion nothing but the blink runs`).toEqual([]);
};

// ─── the journey ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the first run, end to end', () => {
  // r11-1b G6: the first variant is walked twice: the machines answer at once, then every answer 100 ms late (a covered page).
  for (const variant of VARIANTS)
    for (const latency of variant === VARIANTS[0] ? [0, 1, 100] : [0])
      it(`${variant.name}: First time, then a second machine's Pair journey${latency === 0 ? '' : ` (every machine answer ${latency} ms late)`}`, async () => {
        latencyNow = latency;
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
        await context.addInitScript(COVER_LOG);
        await context.addInitScript(NEXT_SPINNER_LOG);
        const tab = await context.newPage();
        tab.setDefaultTimeout(loadAware(60_000, IDLE_FRAME_MS));
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
        await tab.goto(`${origin}/pair?theme=${theme}&latency=${latency}`);
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
        await measureButton(tab, variant, 'Pair this device', '[data-pair-confirm]', 2);
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
        // ── "Which AI do you want to use?" is the first page, over the machine's REAL provider catalog ─────────────────
        await reach(tab, 'onboarding.agents');
        walked.push('onboarding.agents');
        const agentBox = (row: string) => tab.locator(`[data-agent-row="${row}"] > label input`);
        expect(await agentBox('claude-code').isChecked(), 'Which AI: Claude is ticked first').toBe(true);
        await agentBox('others').click();
        await tab.waitForSelector('[data-agent-providers] [data-agent-row]');
        const offered = async (): Promise<string[]> =>
          await tab
            .locator('[data-agent-providers] > [data-agent-row]')
            .evaluateAll(rows => rows.map(row => row.getAttribute('data-agent-row') ?? ''));
        expect(await offered(), 'Which AI: Others lists the catalog providers a supported harness runs').toEqual([
          'provider-anthropic-api-key',
          'provider-amazon-bedrock',
          'provider-amazon-bedrock-api-key',
          'provider-bedrock-mantle',
          'provider-google-vertex',
          'provider-microsoft-foundry-api-key',
          'provider-microsoft-foundry-azure-cli',
          'provider-zai-glm',
          'provider-kimi',
          'provider-minimax',
          'provider-deepseek',
          'provider-qwen-coding-plan',
          'provider-openrouter',
          'provider-vercel-ai-gateway',
          'provider-litellm',
          'provider-custom-gateway',
          'provider-openai-api-key',
          'provider-azure-openai',
          'provider-ollama-codex',
        ]);
        const harnessChoices = async (provider: string): Promise<string[]> => {
          await agentBox(`provider-${provider}`).check();
          const values = await tab
            .locator(`[data-agent-harness="${provider}"] input`)
            .evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
          await agentBox(`provider-${provider}`).uncheck();
          return values;
        };
        expect(await harnessChoices('zai-glm'), 'Which AI: GLM (Z.ai) runs in Claude Code').toEqual(['claude-code']);
        for (const provider of ['kimi', 'minimax', 'deepseek'])
          expect(await harnessChoices(provider), `Which AI: ${provider} offers Claude Code and Codex`).toEqual([
            'claude-code',
            'codex',
          ]);
        await agentBox('others').uncheck();
        // Claude AND Codex: this journey walks both harnesses.
        await agentBox('codex').check();
        // The bar draws the segments of the harnesses picked, so it is read once the pick is the one the run walks.
        await tab.waitForFunction(
          () => document.querySelectorAll('[data-step-progress] [data-segment]').length >= 7,
          undefined,
          { timeout: loadAware(15_000, IDLE_FRAME_MS) },
        );
        await inspect(tab, variant, 'onboarding.agents', { first: true });
        await shot(tab, variant, 'onboarding.agents');
        await tab.locator('[data-step-next]').click();
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
        await inspect(tab, variant, 'onboarding.name');
        // C59 follow-up: ONE set of actions. The form draws no Save name / Not now of its own; the footer's Later and Next are the
        // answers (Next saves the name on screen), so the page never shows two rows of buttons for one step.
        expect(
          await tab.locator('[data-flow-page="onboarding.name"] form button').count(),
          'Machine name: the form has no buttons of its own',
        ).toBe(0);
        expect(await tab.getByRole('button', { name: 'Save name' }).count(), 'no second "Save name"').toBe(0);
        expect(await tab.locator('[data-step-later]').count(), 'the footer carries Later').toBe(1);
        expect(await tab.locator('[data-step-next]').count(), 'the footer carries Next').toBe(1);
        // The card sits on the page's own edges (it was inset 12 px on each side of the title and the progress bar).
        const edges = await tab.evaluate(() => {
          const card = (document.querySelector('[data-name-machine]') as HTMLElement).getBoundingClientRect();
          const title = (document.querySelector('h1') as HTMLElement).getBoundingClientRect();
          return { cardLeft: card.left, titleLeft: title.left };
        });
        expect(
          Math.abs(edges.cardLeft - edges.titleLeft),
          'Machine name: the card shares the title’s left edge',
        ).toBeLessThanOrEqual(1);
        await shot(tab, variant, 'onboarding.name');
        // Next saves the name: the machine takes it through the host file, and the flow goes on by itself.
        // A name that is NOT the one the field starts with (the machine's host name), so the payload proves the typed name was sent.
        await tab.getByLabel('Machine name').last().fill('harbor-lamp');
        await tab.locator('[data-step-next]').click();
        await reach(tab, 'claude-code.import-choice');
        const nameWrites = (await daemonOf(tab, A)).writes.filter(
          write => write.route === 'PUT /v1/config/file' && (write.body as { path?: string }).path === 'host.yaml',
        );
        expect(
          nameWrites.map(write => write.body),
          'the name went to the machine once, as exactly this host.yaml',
        ).toEqual([{ path: 'host.yaml', text: 'name: "harbor-lamp"\n', etag: 'e1' }]);
        expect(await recorded(tab, A, 'onboarding.name'), 'Machine name recorded').toMatch(/done|skipped/u);

        // ── Claude: installed and signed in are never asked; Choose what to import ──────────────────────────────────
        walked.push('claude-code.import-choice');
        await inspect(tab, variant, 'claude-code.import-choice');
        // Item 1: the count is known from the answer BEFORE the next page: Import everything (the default) will show 5 pages, not 10.
        expect(await counterOf(tab), 'Claude: Import everything counts the pages it will show').toBe(
          'Claude Code · page 1 of 5',
        );
        await shot(tab, variant, 'claude-code.import-choice');
        await backAndForth(tab, 'onboarding.name', 'claude-code.import-choice');
        await laterThenBack(tab, A, 'claude-code.import-choice');
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
          'Claude Code · page 1 of 10',
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
          if (key === 'claude-code.import-settings') {
            // r11-1c C1 (the gate's count): the real flow's `.fy-sf-slot` text with ONLY the card titles (group headings and
            // card labels) taken out, whitespace folded — the scanned key names, the page line and every sentence counted.
            await tab.waitForTimeout(1_800);
            const slot = await tab.evaluate(() => {
              const root = document.querySelector('.fy-sf-slot') as HTMLElement;
              const flat = (value: string) => value.replace(/\s+/gu, ' ').trim();
              let text = flat(root.innerText);
              for (const title of root.querySelectorAll('h4, .text-row')) {
                const own = flat((title as HTMLElement).innerText);
                if (own !== '') text = text.replace(own, '');
              }
              return flat(text);
            });
            console.log(`C1 Settings page slot text ${variant.name} (${String(slot.length)} chars): ${slot}`);
            expect(
              slot.length,
              `Settings page slot text, card titles out and nothing else: ${slot}`,
            ).toBeLessThanOrEqual(160);
          }
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

        // Permission (r11 O4): an arrow key moves the focus and writes nothing; Enter selects and still writes nothing; the page has
        // no button of its own, and Next with the saved card showing leaves the default as it was.
        await reach(tab, 'claude-code.permission');
        walked.push('claude-code.permission');
        await inspect(tab, variant, 'claude-code.permission');
        await shot(tab, variant, 'claude-code.permission');
        const permBefore = (await daemonOf(tab, A)).mutations.length;
        await tab.locator('input[type="radio"]:checked').first().focus();
        await tab.keyboard.press('ArrowUp');
        await tab.waitForTimeout(300);
        expect((await daemonOf(tab, A)).mutations.length, 'an arrow key on Permissions wrote nothing').toBe(permBefore);
        expect(
          await tab.locator('[data-flow-page="claude-code.permission"] button').count(),
          'Permissions draws no button of its own',
        ).toBe(0);
        // Enter chooses the focused card; that alone still writes nothing (only Next does).
        await tab.keyboard.press('Enter');
        await tab.waitForTimeout(300);
        expect((await daemonOf(tab, A)).mutations.length, 'choosing a card on Permissions wrote nothing').toBe(
          permBefore,
        );
        await shot(tab, variant, 'claude-code.permission-picked');
        // Back to the saved card: Next has nothing to save.
        await tab.locator('[data-flow-page="claude-code.permission"] [data-choice="skip"]').click();
        await tab.waitForTimeout(300);
        await next(tab, 'claude-code.ready');
        expect(await recorded(tab, A, 'claude-code.permission')).toBe('done');

        // Ready (O9-6): the Claude segment ENDS by saying what the pick came to: a runtime (the fake machine has one per tool).
        await reach(tab, 'claude-code.ready');
        walked.push('claude-code.ready');
        await inspect(tab, variant, 'claude-code.ready');
        await shot(tab, variant, 'claude-code.ready');
        expect(await tab.locator('[data-runtime-ready="ready"]').innerText(), 'Claude says it is ready').toContain(
          'Claude Code is ready',
        );
        await next(tab, 'codex.import-choice');
        expect(await recorded(tab, A, 'claude-code.ready')).toBe('done');

        // ── Codex: Import everything ────────────────────────────────────────────────────────────────────────────────
        await reach(tab, 'codex.import-choice');
        walked.push('codex.import-choice');
        await inspect(tab, variant, 'codex.import-choice');
        await shot(tab, variant, 'codex.import-choice');
        await laterThenBack(tab, A, 'codex.import-choice');
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
        const writesOf = async (route: string) =>
          (await daemonOf(tab, A)).writes.filter(write => write.route === route);
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
        expect(budget.all, 'no raw URL anywhere on the page, key row included').not.toMatch(
          /https?:|www\.|\.com|\.test/,
        );
        expect(
          budget.all.length,
          'the stated 160-character budget, key row and card titles counted',
        ).toBeLessThanOrEqual(160);
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
        expect(
          (await daemonOf(tab, A)).mutations.length,
          'an arrow key on Appearance wrote nothing to the machine',
        ).toBe(appearanceBefore);
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
        // r11-1b G3 (line 1): an Install button is a full 136 px wide, the same floor as the footer's.
        const installWidths = await tab
          .locator('.fy-engine-card button.fy-engine-mini')
          .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().width * 10) / 10));
        for (const width of installWidths)
          expect(width, 'Voice: an Install button is >= 136 px wide').toBeGreaterThanOrEqual(136);
        await shot(tab, variant, 'voice.voice');
        // r11-1b G3 (line 14): every focus ring on the real page, 'Show every engine' included, stays inside the frame.
        const voiceRings = await walkFocusRings(tab);
        expect(
          voiceRings.stops.some(stop => stop.label.includes('Show every engine')),
          'Voice: Tab reaches "Show every engine"',
        ).toBe(true);
        expect(voiceRings.violations, 'Voice: no focus ring is cut by main.fy-main or div.fy-frame').toEqual([]);
        // r11 O12: "Show every engine" is a disclosure (a summary), not a button.
        await tab.getByText('Show every engine').click();
        await tab.waitForFunction(() => document.querySelectorAll('.fy-engine-card').length > 4);
        // r11-1c C2 (line 14): the same walk AFTER the list is open. The last engine card's radio ring used to cross the bottom of
        // main.fy-main / div.fy-frame by 5.4 px at 1280, which the walk above (list closed) never reached.
        const openRings = await walkFocusRings(tab, 150);
        expect(['wrapped', 'left-page'], 'Voice (every engine): the walk came all the way round').toContain(
          openRings.ended,
        );
        expect(
          openRings.violations,
          'Voice (every engine): no focus ring is cut by main.fy-main or div.fy-frame',
        ).toEqual([]);
        // The engine cards are one radio group (one Tab stop): the arrow keys reach the rest, so walk THEM too, each card's ring.
        const cards = await tab.locator('.fy-engine-card').count();
        const arrows = await arrowWalkRings(tab, 'input.fy-engine-radio', 'data-engine');
        expect(arrows.ids.length, 'Voice (every engine): an arrow stop for every card').toBe(cards);
        // A stalled arrow would measure the same card again: the engine ids must all differ.
        expect(
          new Set(arrows.ids).size,
          `Voice (every engine): every arrow stop is a different engine (${arrows.ids.join(',')})`,
        ).toBe(cards);
        expect(arrows.stops.length, 'Voice (every engine): every engine card was measured').toBe(cards);
        expect(
          arrows.violations,
          'Voice (every engine): no engine card ring is cut by main.fy-main or div.fy-frame',
        ).toEqual([]);
        // The two cases a scroll cannot be trusted with, on the real page: a card 2 px under the frame top (pressed, then Shift), and a card
        // the frame has left partly out of view (keyboard focus WITHOUT scrolling). The ring is inside the card, so both measure 0.
        const edge = await edgeRings(tab, '.fy-engine-card', 'input.fy-engine-radio');
        expect(
          Math.abs(edge.nearTop.gap - 2),
          `Voice: a card sits 2 px under the frame top (${edge.nearTop.gap})`,
        ).toBeLessThan(1);
        expect(
          Math.abs(edge.nearTop.gapAtRing - 2),
          `Voice: the press did not move the card (${edge.nearTop.gapAtRing})`,
        ).toBeLessThan(1);
        expect(
          edge.partlyHidden.gap,
          `Voice: a card is partly above the frame (${edge.partlyHidden.gap})`,
        ).toBeLessThan(-10);
        expect(edge.nearTop.stop?.painted, 'Voice: the pressed card has a ring after Shift').toBe(true);
        expect(edge.partlyHidden.stop?.painted, 'Voice: the partly hidden card has a ring').toBe(true);
        expect(
          {
            'press + Shift, card 2 px from the top': edge.nearTop.stop?.violations,
            'preventScroll focus, card partly hidden': edge.partlyHidden.stop?.violations,
          },
          'Voice (every engine): no ring is cut by main.fy-main or div.fy-frame at the frame edge',
        ).toEqual({
          'press + Shift, card 2 px from the top': [],
          'preventScroll focus, card partly hidden': [],
        });
        // The Off card, on its own, so it can be seen in the picture (the page shot scrolls past it).
        const off = tab.locator('.fy-engine-card[data-engine="off"]');
        // Centred, so the footer bar does not sit over its lower half in the picture.
        await off.evaluate(node => node.scrollIntoView({ block: 'center' }));
        // The first-run card is short (r11 O12): just its name, its sentence is drawn only when the card is open elsewhere.
        expect(await off.isVisible(), 'Voice: the Off card is listed once every engine is shown').toBe(true);
        expect((await off.innerText()).trim(), 'Voice: the Off card is just its name').toBe('Off');
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
        await endHeadingInView(tab, variant, 'voice -> end');
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
          'Codex: Import everything reads page 1 of 5 on its first page and walks 1 to 5 (the last is Codex is ready)',
        ).toEqual([
          [1, 5],
          [2, 5],
          [3, 5],
          [4, 5],
          [5, 5],
        ]);
        expect(
          new Set(
            run
              .filter(counter => counter.key.startsWith('claude-code.') && counter.key !== 'claude-code.import-choice')
              .map(counter => counter.of),
          ).size,
          'Claude: after Choose is picked n stays 10 on every later page',
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
        await endMascot(tab, variant, 'end');
        // Every machine step ended up answered, each exactly once.
        const done = await daemonOf(tab, A);
        for (const step of MACHINE_A.steps.filter(candidate => candidate.side === undefined)) {
          const key = `${step.plugin}.${step.id}`;
          expect(done.states[key], `${key} was answered on the machine`).toBeDefined();
          // The two import choices were left with Later once and answered by Next afterwards: that is a Later, then ONE final answer.
          expect(
            done.answers.filter(
              answer => answer.plugin === step.plugin && answer.id === step.id && answer.state === done.states[key],
            ).length,
            `${key} was answered exactly once (its final answer)`,
          ).toBe(1);
        }
        expect(walked, 'the first-run pages, in order').toEqual(
          expect.arrayContaining([
            'onboarding.agents',
            'onboarding.name',
            'claude-code.import-choice',
            'claude-code.import-settings',
            'claude-code.import-skills',
            'claude-code.import-run',
            'claude-code.permission',
            'claude-code.ready',
            'codex.ready',
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
        await measureButton(tab, variant, 'Open the pairing page', '[data-onboarding-open-pair]', 1);
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
        await endHeadingInView(tab, variant, 'passkey -> end');
        expect(Object.keys(await ledgerOf(tab))).toContain('access.passkey');
        expect((await ledgerOf(tab))['access.passkey']?.daemons, 'the passkey answer is for the new machine').toEqual([
          B,
        ]);
        await shot(tab, variant, 'end-pair');
        await endPage(tab, variant, 'end-pair');
        await endMascot(tab, variant, 'end-pair');
        // The Pair journey's ending has the same summary: what this device now holds, and where to change it.
        const pairSummary = await tab.locator('[data-onboarding-summary]').innerText();
        expect(pairSummary, 'end-pair: the summary says what was set up on this device').toMatch(/this device\s/iu);
        expect(pairSummary, 'end-pair: the summary names the Passkey page').toContain('Passkey');
        expect(pairSummary, 'end-pair: the summary says where to change it').toMatch(/Settings/u);
        const second = await daemonOf(tab, B);
        expect(second.answers, 'a Pair journey answers nothing on the new machine (it is not being set up)').toEqual(
          [],
        );
        expect(
          walked.filter(key => ['onboarding.appearance', 'layouts.layout', 'voice.voice'].includes(key)),
        ).toHaveLength(3);
        // Each client page was asked once in the whole journey: the Pair journey did not ask them again.
        expect(walked.filter(key => key === 'onboarding.appearance')).toHaveLength(1);

        if (shotsDir !== '')
          await Bun.write(join(shotsDir, `${variant.name}-end-measured.txt`), `${mascotMeasured.join('\n')}\n`);
        mascotMeasured.length = 0;
        if (shotsDir !== '')
          await Bun.write(join(shotsDir, `${variant.name}-counters.txt`), `${seen.counters.join('\n')}\n`);
        seen.counters.length = 0;
        seen.unanswered = [...(await daemonOf(tab, A)).unanswered, ...(await daemonOf(tab, B)).unanswered];
        for (const cover of await tab.evaluate(
          () => (window as unknown as { __covers: { ms: number; fullMs: number; gapMs: number }[] }).__covers,
        ))
          seen.covers.push({
            latency,
            variant: variant.name,
            ms: Math.round(cover.ms),
            fullMs: Math.round(cover.fullMs),
            gapMs: Math.round(cover.gapMs),
          });
        for (const spinner of await tab.evaluate(
          () => (window as unknown as { __nextSpinner: NextSpinnerRun[] }).__nextSpinner,
        ))
          seen.nextSpinners.push({
            latency,
            variant: variant.name,
            ms: Math.round(spinner.ms),
            fullMs: Math.round(spinner.fullMs),
            gapMs: Math.round(spinner.gapMs),
          });
        await context.close();
      });
});

// ─── the End page of a short Pair journey, with Access on and with Access switched off on the machine ───────────────────
describe('the End page of a Pair journey', () => {
  for (const variant of VARIANTS)
    for (const access of ['on', 'paused'] as const)
      it(`${variant.name}: Access ${access}: ${access === 'on' ? "the picture is Access's ferret, in the real shell" : 'no picture column, the one primary still opens the machine'}`, async () => {
        const browser = await sharedChromium();
        const phone = variant.width < 600;
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          colorScheme: variant.dark ? 'dark' : 'light',
          deviceScaleFactor: phone ? 2 : 1,
          hasTouch: phone,
          isMobile: phone,
        });
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        // This device already set Appearance, Layout and Voice, so the Pair journey has nothing else to ask once Access is off.
        await context.addInitScript(
          ({ key, daemon }) =>
            window.localStorage.setItem(
              key,
              JSON.stringify({
                format: 1,
                steps: Object.fromEntries(
                  ['onboarding.appearance', 'layouts.layout', 'voice.voice'].map(step => [
                    step,
                    { at: '2026-11-20T10:00:00.000Z', daemons: [daemon] },
                  ]),
                ),
              }),
            ),
          { key: 'fy:onboarding:client', daemon: MACHINE_B.id },
        );
        const tab = await context.newPage();
        tab.setDefaultTimeout(loadAware(60_000, IDLE_FRAME_MS));
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        try {
          await tab.goto(
            `${origin}/pair?theme=studio-${variant.dark ? 'dark' : 'light'}${access === 'paused' ? '&paused=access' : ''}`,
          );
          await tab.getByText('Paste a link').click();
          await tab.getByLabel('Pairing link').fill(pairLinkOf(MACHINE_B, origin));
          await tab.getByText('Use this link').click();
          await tab.locator('[data-pair-confirm]').waitFor();
          await tab.locator('[data-pair-confirm]').click();
          const offer = tab.locator('[data-first-passkey-offer]');
          if (
            await offer.waitFor({ timeout: 4_000 }).then(
              () => true,
              () => false,
            )
          )
            await tab.getByRole('button', { name: 'Not now' }).click();
          // The paired machine's own setup flow, the Pair journey (what this device already set is skipped).
          await tab.evaluate(path => {
            history.pushState(null, '', path);
            dispatchEvent(new PopStateEvent('popstate'));
          }, `/d/${MACHINE_B.id}/onboarding/setup?phase=client&journey=pair`);
          if (access === 'on') {
            // Access's own Passkey page is the one step this device has not answered.
            await reach(tab, 'access.passkey');
            await next(tab, 'end');
            await endHeadingInView(tab, variant, 'passkey -> end');
            await endMascot(tab, variant, `short ${variant.name}`);
            if (shotsDir !== '') {
              await tab.evaluate(() =>
                (document.querySelector('.fy-spf__title') as HTMLElement).scrollIntoView({ block: 'start' }),
              );
              await tab.screenshot({ path: join(shotsDir, `${variant.name}-short-end-top.png`) });
              await tab.evaluate(() => {
                for (
                  let el: Element | null = document.querySelector('[data-step-footer]');
                  el !== null;
                  el = el.parentElement
                )
                  if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
              });
              await tab.waitForTimeout(150);
              await tab.screenshot({ path: join(shotsDir, `${variant.name}-short-end-bottom.png`) });
            }
            expect(await tab.locator('[data-variant="primary"]:visible').count(), 'exactly one primary button').toBe(1);
            expect(problems).toEqual([]);
            return;
          }
          await reach(tab, 'end');
          expect(await tab.locator('[data-flow-end]').count(), 'the End page is drawn').toBe(1);
          expect(await tab.locator('.fy-slot[data-slot="onboarding.end"]').count(), 'no picture slot is drawn').toBe(0);
          expect(await tab.locator('[data-end-mascot]').count(), 'no empty picture column is left behind').toBe(0);
          expect(await tab.locator('[data-variant="primary"]:visible').count(), 'exactly one primary button').toBe(1);
          expect(await tab.locator('[data-step-footer] [data-variant="primary"]').innerText()).toBe(
            'Open this machine',
          );
          await tab.locator('[data-step-next]').click();
          await tab.waitForURL(url => url.pathname.startsWith(`/d/${MACHINE_B.id}`));
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
});

// ─── what the run found (each gap was `it.failing` until it was fixed; now each is a plain test) ───────────────────────
describe('the gaps the gate found, now closed', () => {
  // r11-1b G6 (owner line 4): the machines here answer at once, so a step the person moves to draws at once. A page whose
  // lazy module had not been used yet paid React's 300 ms hold on its first draw (Lessons to Appearance 775-1254 ms,
  // Appearance to Layouts ~400 ms at the gate); the flow now draws the next two pages hidden while the current one shows.
  // The line is the owner's 150 ms (base 416 ms for the Lessons move; the Shells pass-over and the machine write sit in it).
  it('moving onto Appearance and onto Layouts stays under the 300 ms hold (the next pages were drawn in advance)', () => {
    const immediate = moves.filter(move => move.latency === 0);
    console.info(`G6 moves: ${immediate.map(move => `${move.from} -> ${move.to} ${move.ms} ms`).join('; ')}`);
    for (const target of ['onboarding.appearance', 'layouts.layout']) {
      const onto = immediate.filter(move => move.to === target);
      expect(onto.length, `the run moved onto ${target}`).toBeGreaterThan(0);
      for (const move of onto)
        expect(
          move.ms,
          `${move.from} -> ${target}: ms from Next to ready (frames ${move.frameMs.toFixed(1)} ms)`,
        ).toBeLessThan(moveReadyLimit(move.frameMs, hostSlowdown()));
    }
  });
  // FORCED REGRESSIONS (end B5 review). The load-aware budget is judged at a SIMULATED host of load 60 on 32 cores (slowdown 1.875,
  // the target the gate runs at), with idle frames: the two regressions the gate documents must still be red, the real code green.
  describe('at a simulated load-60 / 32-core host the load-aware budget still catches its regressions', () => {
    const SIMULATED_SLOWDOWN = 60 / 32;
    it('a loader removed early (126.5 ms on screen, never fully opaque) is red; the real hold (460 / 300 ms) is green', () => {
      expect(
        holdShortfalls({ ms: 126.5, fullMs: 0, gapMs: IDLE_FRAME_MS }),
        'the premature removal measured at the gate',
      ).toHaveLength(2);
      // the same blink with the late frames a loaded host shows (6x idle) is still red, and so is the load-60 minima 85 / -75
      expect(holdShortfalls({ ms: 126.5, fullMs: 0, gapMs: IDLE_FRAME_MS * 6 })).toHaveLength(2);
      expect(holdShortfalls({ ms: 85, fullMs: -75, gapMs: IDLE_FRAME_MS * 6 })).toHaveLength(2);
      expect(holdShortfalls({ ms: 460, fullMs: 300, gapMs: IDLE_FRAME_MS })).toEqual([]);
      expect(holdShortfalls({ ms: 380, fullMs: 250, gapMs: IDLE_FRAME_MS * 6 })).toEqual([]);
    });
    it('a missed preload (416 ms from Next to ready) is red; a preloaded move (140 ms) is green', () => {
      expect(416, 'the Lessons move on base').toBeGreaterThanOrEqual(moveReadyLimit(IDLE_FRAME_MS, SIMULATED_SLOWDOWN));
      expect(140).toBeLessThan(moveReadyLimit(IDLE_FRAME_MS, SIMULATED_SLOWDOWN));
      // the limit never reaches the 300 ms hold, whatever the load
      expect(moveReadyLimit(IDLE_FRAME_MS * 10, 10)).toBeLessThan(LOADING_DELAY_MS);
      // the idle bound is the owner's 150 ms
      expect(moveReadyLimit(IDLE_FRAME_MS, 0)).toBe(150);
    });
  });
  // The same journey with every machine answer 100 ms late: a page whose reads add up past 300 ms puts up the cover's loader, and
  // that loader must then stay for its minimum (a cover that blinked for 50-183 ms eight times on base).
  it('a journey whose answers are 100 ms late never blinks a cover: each loader that came up stayed for its minimum', () => {
    const slow = seen.covers.filter(cover => cover.latency === 100);
    console.info(
      `G6 covers at 100 ms answers (on screen / fully shown): ${slow.map(cover => `${cover.ms}/${cover.fullMs} ms`).join(', ') || 'none'}`,
    );
    // The picker is now the first page and the name page is drawn in advance while it is on screen, so a journey of 100 ms
    // answers may put up no cover at all (nothing blinked). It must still have WALKED the journey that slowly.
    expect(
      moves.filter(move => move.latency === 100).length,
      'the slow journey walked pages (otherwise this proves nothing)',
    ).toBeGreaterThan(0);
    for (const cover of seen.covers)
      expect(holdShortfalls(cover), `a cover's loader (frames up to ${cover.gapMs} ms apart)`).toEqual([]);
  });
  // r11-1c C3 (owner line 4, the gate's one literal miss): the Next button's own busy spinner is a loader for a short step, so it waits
  // the same 300 ms as a page loader and, once shown, stays for its minimum. Base drew it at once: 15-38 ms at 1 ms answers.
  it('the Next button spinner never flashes: none for answers under the delay, and once shown it stays for its minimum', () => {
    const runs = (latency: number) => seen.nextSpinners.filter(spinner => spinner.latency === latency);
    for (const latency of [0, 1, 100])
      console.info(
        `C3 Next spinner at ${latency} ms answers (on screen / fully shown): ${
          runs(latency)
            .map(spinner => `${spinner.ms}/${spinner.fullMs} ms`)
            .join(', ') || 'never drawn'
        }`,
      );
    for (const latency of [0, 1])
      expect(runs(latency), `answers ${latency} ms late: the Next spinner is never visible`).toEqual([]);
    for (const spinner of seen.nextSpinners)
      expect(
        holdShortfalls(spinner),
        `the Next spinner (answers ${spinner.latency} ms late, frames up to ${spinner.gapMs} ms apart)`,
      ).toEqual([]);
  });
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
  it('the pairing page buttons are full width on a phone, under half the page on a desktop, and 44px tall', () => {
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
