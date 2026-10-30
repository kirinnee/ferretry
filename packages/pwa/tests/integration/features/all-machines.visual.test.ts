/**
 * ONE SESSION LIST ACROSS TWO MACHINES, in a real browser, against two fake daemons — one answering
 * (studio), one that answered five minutes ago and has not since (laptop).
 *
 * The scene (`tests/integration/fixtures/all-machines-scene.tsx`) is the real fleet, project and
 * health stores, the real `useMachinesPoll` / `useMachineSources`, and the real sessions bar and
 * Sessions page. It is built in a child process — never inside this runner — and served from loopback,
 * so no request can leave the page.
 *
 * What is proved:
 *   - every list was read with ITS machine's own device, and both machines were read;
 *   - Needs you holds the answering machine's waiting sessions, most urgent first, each naming its
 *     machine; the offline machine's waiting session stays under its own greyed heading;
 *   - the offline machine says "offline · last seen 5m", and its rows are greyed;
 *   - the same session id on two machines is two rows, and only this machine's is the open one;
 *   - a row opens its own machine's session, and "+ New" asks which machine, this one first;
 *   - a phone and a desktop, light and dark, never scroll sideways;
 *   - crowded, the compact bar draws one short line per session and a quiet one-line machine label,
 *     the selected row alone opens to a second line, and Comfortable keeps the full rows — all
 *     without sideways scroll, on the desktop column and the phone drawer, light and dark.
 *
 * Set `FY_ALL_MACHINES_SHOTS_DIR` to keep the captures for review; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from '../support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../../..');
const shotsDir = process.env.FY_ALL_MACHINES_SHOTS_DIR ?? '';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

interface Evidence {
  readonly studio: string;
  readonly laptop: string;
  readonly reads: readonly { readonly daemonId: string; readonly deviceId: string; readonly what: string }[];
  readonly navigations: readonly string[];
}

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-all-machines-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/all-machines-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the all-machines scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

const open = async (
  scene: 'bar' | 'page' | 'drawer',
  theme: string,
  mode: 'light' | 'dark',
  /** Opens the laptop's session, with the laptop answering. */
  openOn: 'studio' | 'laptop' = 'studio',
  /** Extra scene switches, e.g. `&big=1&density=full`: a crowded list at a chosen density. */
  extra = '',
): Promise<{ readonly context: BrowserContext; readonly tab: Page }> => {
  const phone = scene !== 'bar';
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1_440, height: 900 },
    colorScheme: mode,
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true, userAgent: ANDROID_UA } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?scene=${scene}&theme=${theme}-${mode}&open=${openOn}${extra}`);
  await tab.waitForSelector(
    openOn === 'studio'
      ? '[data-machine-reach="offline"]'
      : '[data-machine-reach="online"] + [data-machine-reach="online"]',
  );
  return { context, tab };
};

const evidence = async (tab: Page): Promise<Evidence> =>
  await tab.evaluate(() => (globalThis as unknown as { __allMachines: Evidence }).__allMachines);

const texts = async (tab: Page, selector: string): Promise<readonly string[]> =>
  await tab.$$eval(selector, nodes => nodes.map(node => (node as HTMLElement).innerText.replace(/\s+/gu, ' ').trim()));

describe('one session list across two machines, one offline', () => {
  beforeAll(async () => {
    browser = await sharedChromium();
    const { css, js } = await build();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
        if (path === '/app.css') return new Response(css, { headers: { 'content-type': 'text/css' } });
        if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
        return new Response('not here', { status: 404 });
      },
    });
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    server?.stop(true);
    if (directory !== '') await rm(directory, { force: true, recursive: true });
  });

  it('reads each machine with its own device, pins what needs you, and greys the offline machine', async () => {
    const { context, tab } = await open('bar', 'studio', 'light');
    try {
      const seen = await evidence(tab);
      const devices = new Map([
        [seen.studio, 'device-on-studio'],
        [seen.laptop, 'device-on-laptop'],
      ]);
      // Every read went to a paired machine, with that machine's device — never the other's.
      for (const read of seen.reads) expect(read.deviceId).toBe(devices.get(read.daemonId) as string);
      expect(
        seen.reads.filter(read => read.daemonId === seen.studio && read.what === 'sessions').length,
      ).toBeGreaterThan(0);
      // Once five minutes ago, and again by the poll, which it no longer answers.
      expect(
        seen.reads.filter(read => read.daemonId === seen.laptop && read.what === 'sessions').length,
      ).toBeGreaterThan(1);

      // Needs you: studio's question before its request for a human; each row names its machine.
      const pinned = await texts(tab, '[data-sbar-needs-you-group] [data-sbar-session]');
      expect(pinned.length).toBe(2);
      expect(pinned[0]).toContain('Hadi');
      expect(pinned[1]).toContain('Ora');
      expect(await texts(tab, '[data-sbar-needs-you-group] [data-machine-chip]')).toEqual(['studio', 'studio']);

      // Machines in the order they were paired; the offline one says when it was last seen.
      expect(await texts(tab, '.fy-sbar__machine-label')).toEqual(['studio', 'laptop']);
      expect(await texts(tab, '[data-machine-reach="offline"] .fy-sbar__machine-reach')).toEqual([
        'offline · last seen 5m',
      ]);
      // Its waiting session stays home, greyed — nobody can answer a machine that is not answering.
      const laptopRows = await texts(tab, '[data-machine-reach="offline"] [data-sbar-session]');
      expect(laptopRows.some(row => row.includes('Pim'))).toBe(true);
      const opacity = await tab.$eval(
        '[data-machine-reach="offline"] .fy-sbar__group',
        node => getComputedStyle(node).opacity,
      );
      expect(Number(opacity)).toBeLessThan(1);

      // `s-ivo` is a session on BOTH machines; only studio's is the open one.
      expect(await tab.$$eval('[data-sbar-session="s-ivo"]', nodes => nodes.length)).toBe(2);
      expect(await texts(tab, '[data-sbar-session="s-ivo"][aria-current="page"]')).toHaveLength(1);
      expect((await texts(tab, '[data-sbar-session="s-ivo"][aria-current="page"]'))[0]).toContain('Ivo');

      // A laptop row opens the LAPTOP's session.
      await tab.click('[data-machine-reach="offline"] [data-sbar-session="l-pim"]');
      expect((await evidence(tab)).navigations.at(-1)).toBe(
        `/d/${encodeURIComponent(seen.laptop)}/session/l-pim?agenda=A1`,
      );

      // "+ New" asks which machine: this one first and marked; the laptop is not answering, so it is
      // listed but unavailable, saying why — a new session cannot start on a machine nobody can reach.
      await tab.click('[data-new-session-menu]');
      const menu = '[role="menu"][aria-label="New session on"]';
      await tab.waitForSelector(menu, { state: 'visible' });
      // Read as text content: the menu is mid-entry when it first turns visible.
      const items = await tab.$$eval(`${menu} [role="menuitem"]`, nodes =>
        nodes.map(node => [node.textContent ?? '', (node as HTMLButtonElement).disabled] as const),
      );
      expect(items[0]?.[0]).toContain('studio');
      expect(items[0]?.[0]).toContain('this one');
      expect(items[0]?.[1]).toBe(false);
      expect(items[1]?.[0]).toContain('laptop isn’t reachable right now');
      expect(items[1]?.[1]).toBe(true);
      await tab.click(`${menu} [role="menuitem"]:nth-of-type(1)`);
      expect((await evidence(tab)).navigations.at(-1)).toBe(`/d/${encodeURIComponent(seen.studio)}/new`);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('opens the second machine’s session without moving the list, and marks both machines’ learners', async () => {
    const { context, tab } = await open('bar', 'studio', 'light', 'laptop');
    try {
      const seen = await evidence(tab);
      // The machine just opened is NOT hoisted: the list holds the order it had.
      expect(await texts(tab, '.fy-sbar__machine-label')).toEqual(['studio', 'laptop']);
      expect(await texts(tab, '[data-sbar-machine] .fy-sbar__machine-name')).toEqual(['laptop']);
      // `s-ivo` runs on both; the open one is the laptop's, and only it.
      const current = `[data-sbar-machine-group="${seen.laptop}"] [data-sbar-session="s-ivo"][aria-current="page"]`;
      expect(await tab.$$eval('[data-sbar-session][aria-current="page"]', nodes => nodes.length)).toBe(1);
      expect(await tab.$$eval(current, nodes => nodes.length)).toBe(1);
      // Each machine marks ITS learners — the studio's too, though the laptop is the one on screen.
      const learns = async (machine: string, id: string): Promise<boolean> =>
        (await tab.$$eval(
          `[data-sbar-machine-group="${machine}"] [data-sbar-session="${id}"] [data-learning-passive]`,
          nodes => nodes.length,
        )) === 1;
      expect([
        await learns(seen.studio, 's-noa'),
        await learns(seen.studio, 's-ivo'),
        await learns(seen.laptop, 's-ivo'),
      ]).toEqual([true, false, true]);
      // A studio row still opens the studio's session.
      await tab.click(`[data-sbar-machine-group="${seen.studio}"] [data-sbar-session="s-ivo"]`);
      expect((await evidence(tab)).navigations.at(-1)).toBe(`/d/${encodeURIComponent(seen.studio)}/session/s-ivo`);
      for (const mode of ['light', 'dark'] as const)
        for (const scene of ['bar', 'drawer'] as const) {
          const shot = await open(scene, 'studio', mode, 'laptop');
          try {
            // The phone drawer is shorter than the list: bring the open row into the capture.
            if (scene === 'drawer')
              await shot.tab.evaluate(() =>
                document.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'center' }),
              );
            const wide = await shot.tab.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            expect(wide).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await writeFile(
                join(shotsDir, `second-machine-open-${scene === 'bar' ? 'desktop' : 'phone'}-${mode}.png`),
                await shot.tab.screenshot({ animations: 'disabled' }),
              );
          } finally {
            await shot.context.close();
          }
        }
    } finally {
      await context.close();
    }
  }, 180_000);

  it('lists Needs you and every machine on the phone Sessions page', async () => {
    const { context, tab } = await open('page', 'studio', 'light');
    try {
      const pinned = await texts(tab, '[data-needs-you-group] [data-session-row]');
      expect(pinned.length).toBe(2);
      expect(pinned[0]).toContain('Hadi');
      expect(await texts(tab, '[data-needs-you-group] [data-machine-chip]')).toEqual(['studio', 'studio']);
      expect(await tab.$$eval('[data-machine-section]', nodes => nodes.length)).toBe(2);
      // The machine that stopped answering says so IN ITS OWN SECTION — its status line, with when its
      // rows are from — and nothing about it reaches the page as a whole.
      expect((await texts(tab, '[data-machine-reach="offline"] h2'))[0]).toContain('offline');
      const status = (await texts(tab, '[data-machine-reach="offline"] [data-machine-status]'))[0] ?? '';
      expect(status).toContain('Unreachable · retrying');
      expect(status).toMatch(/as of \d\d:\d\d/);
      expect(await tab.$$eval('[role="alert"], [data-machine-status-row], [data-cache-updating]', n => n.length)).toBe(
        0,
      );
      // Grouped under the machine already: no chip on a row there.
      expect(await tab.$$eval('[data-machine-section] [data-machine-chip]', nodes => nodes.length)).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('draws compact rows as one short line and Comfortable as the full rows, crowded, without sideways scroll', async () => {
    for (const mode of ['light', 'dark'] as const)
      for (const scene of ['bar', 'drawer'] as const) {
        const heights: Record<string, number> = {};
        for (const density of ['compact', 'full'] as const) {
          const { context, tab } = await open(scene, 'studio', mode, 'laptop', `&big=1&density=${density}`);
          try {
            const wide = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            expect(wide).toBeLessThanOrEqual(0);
            const listWide = await tab.$$eval('.fy-sbar__list', nodes =>
              nodes.map(node => node.scrollWidth - node.clientWidth),
            );
            for (const overflow of listWide) expect(overflow).toBeLessThanOrEqual(0);

            const plain = '[data-sbar-machine-group] [data-sbar-session]:not([aria-current="page"])';
            const rowHeights = await tab.$$eval(plain, nodes => nodes.map(node => node.getBoundingClientRect().height));
            expect(rowHeights.length).toBeGreaterThan(8);
            const tallest = Math.max(...rowHeights);
            heights[density] = Math.min(...rowHeights);
            const head = await tab.$$eval('.fy-sbar__machine-head', nodes =>
              nodes.map(node => node.getBoundingClientRect().height),
            );
            expect(head.length).toBe(2);
            for (const height of head) expect(height).toBeLessThanOrEqual(32);

            const detailBox = await tab.$eval(`${plain} .fy-sbar__detail`, node => {
              const box = node.getBoundingClientRect().height;
              return box > 0 ? box : (node.firstElementChild?.getBoundingClientRect().height ?? 0);
            });
            const open = await tab.$eval('[aria-current="page"] .fy-sbar__detail', node => ({
              height: node.getBoundingClientRect().height,
              ferret: node.querySelector('[data-sbar-ferret]') !== null,
            }));
            if (density === 'compact') {
              // One line: 32px on a pointer, the 44px touch floor on a phone; the detail is clipped away.
              expect(tallest).toBeLessThanOrEqual(scene === 'bar' ? 34 : 46);
              expect(detailBox).toBeLessThanOrEqual(1);
              expect(open.height).toBeGreaterThan(8);
              expect(open.ferret).toBe(true);
            } else {
              expect(detailBox).toBeGreaterThan(8);
            }
            if (shotsDir !== '')
              await writeFile(
                join(shotsDir, `sidebar-${density}-${scene === 'bar' ? 'desktop' : 'phone'}-${mode}.png`),
                await tab.screenshot({ animations: 'disabled' }),
              );
          } finally {
            await context.close();
          }
        }
        expect(heights.compact).toBeLessThan(heights.full as number);
      }
  }, 240_000);

  it('fits a phone and a desktop, light and dark, in two theme families', async () => {
    for (const theme of ['studio', 'neo'])
      for (const mode of ['light', 'dark'] as const)
        for (const scene of ['bar', 'page'] as const) {
          const { context, tab } = await open(scene, theme, mode);
          try {
            const wide = await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            expect(wide).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await writeFile(
                join(shotsDir, `all-machines-${scene === 'bar' ? 'desktop' : 'phone'}-${theme}-${mode}.png`),
                await tab.screenshot({ animations: 'disabled' }),
              );
          } finally {
            await context.close();
          }
        }
  }, 180_000);
});
