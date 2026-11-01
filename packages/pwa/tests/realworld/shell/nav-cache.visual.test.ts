/**
 * BACK, RELOAD AND THE SESSION CACHE, in a real browser, through the REAL SHELL.
 *
 * The scene (`tests/integration/fixtures/nav-cache-scene.tsx`) mounts `RouterProvider > StoreProvider >
 * AppShell` — the app as `App` composes it — over one fake daemon, with Chromium's own IndexedDB (the
 * session cache) and `sessionStorage` (scroll memory and the router's trail) underneath. It is built in
 * a child process, never inside this runner, and served from loopback with the SAME document for every
 * app path, so a reload of `/d/<id>/…` is a real reload of that address. Every off-origin request is
 * aborted: nothing can leave the page.
 *
 * What is proved, on a 1440 desktop and a 390 Android phone:
 *   1. Back — the browser's and the in-app "← Sessions" — returns to the sessions list WITHOUT reloading
 *      the document (a page global survives, the navigation timeline holds one entry, the shell's root
 *      node is the same node) and without a skeleton row on the way back.
 *   2. A reload draws the cached session rows and the cached transcript at once, says "Updating…" while
 *      the daemon's first answer is held, and gives way to the live answer the moment it lands; after
 *      Settings › This device › Cached data is cleared, a held reload draws a skeleton, not old rows.
 *   3. Settings and the sessions list come back where they were scrolled after Back and after a reload;
 *      a chat scrolled up keeps its reading position, detached with "Jump to latest", the same way.
 *
 * REALWORLD, because it is the whole matrix: eight cold boots of the real app (CPU-bound, about 20 s on a
 * 2-vCPU runner) cost more than a merge gate may spend on one claim. The blocking tier keeps every one of
 * these behaviours in `tests/integration/shell/nav-cache.test.ts`, on one desktop, over the same scene; this
 * file adds the phone, the captures and the two-form cross-check.
 *
 * Set `FY_NAV_CACHE_SHOTS_DIR` to keep the captures for review; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import {
  boot,
  cacheSaved,
  chatPositionRemembered,
  type DocumentFacts,
  documentFacts,
  type Form,
  homePathOf,
  listRow,
  markDocument,
  type NavCacheRig,
  nextBoot,
  PILL,
  release,
  rowOnScreen,
  SCROLLER,
  SKELETON,
  scrollTo,
  scrollTopOf,
  sessionsPathOf,
  settlesAt,
  stall,
  startNavCacheRig,
} from '../../integration/support/nav-cache-rig.ts';

const shotsDir = process.env.FY_NAV_CACHE_SHOTS_DIR ?? '';

const FORMS: Form[] = ['desktop', 'phone'];

let rig: NavCacheRig;

/**
 * Runs one journey at both form factors AT ONCE, each in its own browser profile, and fails with the
 * form named. The two never share a context, IndexedDB, storage or history, so running them side by side
 * proves exactly what running them one after the other did, in the time of the slower one.
 */
const eachForm = async (journey: (form: Form) => Promise<void>): Promise<void> => {
  const outcomes = await Promise.allSettled(
    FORMS.map(async form => {
      try {
        await journey(form);
      } catch (error) {
        if (error instanceof Error) error.message = `[${form}] ${error.message}`;
        throw error;
      }
    }),
  );
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
};

const capture = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await writeFile(join(shotsDir, `${name}.png`), await tab.screenshot({ animations: 'disabled' }));
};

describe('navigation without reloads, and the session cache, in the real shell', () => {
  beforeAll(async () => {
    rig = await startNavCacheRig();
    if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await rig?.stop();
  });

  it(
    'draws the cached rows and transcript on reload, then the live answer, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange: one live visit saves the list and s-03's transcript into this profile's IndexedDB.
        const { context, tab } = await rig.open(form);
        try {
          const daemon = await boot(rig, tab);
          await tab.click(listRow('s-03'));
          await tab.waitForSelector('.fy-transcript :text("Live tail of s-03.")');
          await cacheSaved(tab, ['s-03']);
          await nextBoot(tab, { hold: true, renamed: true });

          // Act: a reload of the sessions list with the daemon's first answer held.
          await tab.goto(`${rig.origin}${sessionsPathOf(daemon)}`);
          await tab.waitForSelector(listRow('s-00'));
          // The list as drawn: a desktop table puts the task in its own cell, beside the row's link.
          const cachedList = await tab.$eval(SCROLLER, node => (node as HTMLElement).innerText);
          const pillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
          const skeletonWhileHeld = await tab.$$eval(SKELETON, nodes => nodes.length);
          await tab.emulateMedia({ colorScheme: 'dark' });
          await capture(tab, `sessions-updating-${form}-dark`);
          await tab.emulateMedia({ colorScheme: 'light' });
          await release(tab);
          await tab.waitForSelector(`${SCROLLER} :text("Renamed by the live read")`);
          await tab.waitForSelector(PILL, { state: 'detached' });

          // Act: a reload of the chat, held the same way.
          await nextBoot(tab, { hold: true, renamed: true });
          await tab.goto(`${rig.origin}${homePathOf(daemon)}/session/s-03`);
          await tab.waitForSelector('.fy-transcript :text("Live tail of s-03.")');
          const chatPillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
          await release(tab);
          await tab.waitForSelector('.fy-transcript :text("Fresh tail of s-03.")');
          await tab.waitForSelector(PILL, { state: 'detached' });

          // Assert
          expect(cachedList).toContain('Cached relay bench');
          expect(cachedList).not.toContain('Renamed by the live read');
          expect(pillWhileHeld).toBe(1);
          expect(skeletonWhileHeld).toBe(0);
          expect(chatPillWhileHeld).toBe(1);
          expect(await tab.$$eval('.fy-transcript :text("Live tail of s-03.")', nodes => nodes.length)).toBe(0);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );

  it(
    'shows This device › Cached data, light and dark, and forgets the cache when it is cleared: a held reload draws a skeleton, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange
        const { context, tab } = await rig.open(form);
        try {
          const daemon = await boot(rig, tab);
          await cacheSaved(tab, []);
          await nextBoot(tab, {});
          await tab.goto(`${rig.origin}${homePathOf(daemon)}/settings#device`);
          await tab.waitForSelector('[data-clear-cached-data="idle"]');
          // The section as drawn in light and in dark: the theme follows the OS answer live, so the same
          // profile shows both without a second boot.
          const sectionFacts: { readonly mode: string; readonly text: string; readonly wide: number }[] = [];
          for (const mode of ['light', 'dark'] as const) {
            await tab.emulateMedia({ colorScheme: mode });
            await tab.$eval('[data-clear-cached-data]', node => node.scrollIntoView({ block: 'center' }));
            sectionFacts.push({
              mode,
              text: await tab.$eval('[data-settings-section="device"]', node => (node as HTMLElement).innerText),
              wide: await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth),
            });
            await capture(tab, `settings-cached-data-${form}-${mode}`);
          }
          await tab.emulateMedia({ colorScheme: 'light' });
          // From here on the daemon never answers a list again, so nothing can write the cache back in.
          await stall(tab);

          // Act
          await tab.click('[data-clear-cached-data] button:has-text("Clear cached data")');
          await tab.click('[data-clear-cached-data="confirming"] button:has-text("Clear")');
          await tab.waitForSelector('[data-clear-cached-data="cleared"]');
          await nextBoot(tab, { hold: true });
          await tab.goto(`${rig.origin}${sessionsPathOf(daemon)}`);
          await tab.waitForSelector(SKELETON);
          const rowsWhileHeld = await tab.$$eval(`${SCROLLER} a[href*="/session/"]`, nodes => nodes.length);
          const pillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
          await release(tab);
          await tab.waitForSelector(listRow('s-03'));

          // Assert
          for (const { mode, text, wide } of sectionFacts) {
            expect(text, `${mode} Cached data section text`).toContain('Cached data');
            expect(wide, `${mode} horizontal overflow`).toBeLessThanOrEqual(0);
          }
          expect(rowsWhileHeld).toBe(0);
          expect(pillWhileHeld).toBe(0);
          expect(await tab.$$eval(SKELETON, nodes => nodes.length)).toBe(0);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );

  it(
    'goes Back to the list without reloading the document, and puts Settings and the list back where they were scrolled, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange
        const { context, tab } = await rig.open(form);
        const settings = '[data-settings-scroller]';
        try {
          const daemon = await boot(rig, tab);
          const listIndex = (await documentFacts(tab)).index;
          await markDocument(tab);
          const listTop = await scrollTo(tab, SCROLLER, 1_234);

          // Act: the list, out to a session on screen and Back, then reloaded.
          await tab.click(listRow(await rowOnScreen(tab)));
          await tab.waitForSelector('.fy-transcript');
          await tab.goBack();
          await tab.waitForSelector(listRow('s-03'));
          const afterBrowserBack = await documentFacts(tab);
          const listAfterBack = await settlesAt(tab, SCROLLER, listTop);
          await tab.reload();
          await tab.waitForSelector(listRow('s-03'));
          const listAfterReload = await settlesAt(tab, SCROLLER, listTop);

          // Act: the in-app "← Sessions", from New session opened off the reloaded list.
          const reloadedIndex = (await documentFacts(tab)).index;
          await markDocument(tab);
          await tab.click(`a[href="${homePathOf(daemon)}/new"]`);
          await tab.waitForSelector('#new-session-heading');
          await tab.click('button:has-text("← Sessions")');
          await tab.waitForSelector(listRow('s-03'));
          const afterInAppBack = await documentFacts(tab);
          const pathAfterInAppBack = new URL(tab.url()).pathname;

          // Act: Settings, out to the sessions list and Back, then reloaded.
          // Settings is under More on a phone and in the sidebar on a desktop.
          if (form === 'phone') await tab.click('[data-app-tab="more"]');
          await tab.click(`a[href="${homePathOf(daemon)}/settings"]:visible`);
          await tab.waitForSelector(settings);
          // Behaviour is the longest section at either width.
          await tab.click('[data-settings-section-choice="behaviour"]:visible');
          await tab.waitForFunction(selector => {
            const node = document.querySelector(selector);
            return node !== null && node.scrollHeight > node.clientHeight + 600;
          }, settings);
          const settingsTop = await scrollTo(tab, settings, 500);
          await tab.click(
            form === 'phone' ? `a[href="${sessionsPathOf(daemon)}"]:visible` : '[data-sbar-session="s-05"]',
          );
          await tab.waitForSelector(form === 'phone' ? listRow('s-03') : '.fy-transcript');
          await tab.goBack();
          await tab.waitForSelector(settings);
          const settingsAfterBack = await settlesAt(tab, settings, settingsTop);
          await tab.reload();
          await tab.waitForSelector(settings);
          const settingsAfterReload = await settlesAt(tab, settings, settingsTop);

          // Assert: Back is a step in the same document — nothing reloaded, no skeleton on the way, the trail
          // where it was — and the in-app "← Sessions" is a real step back, not a push of the list.
          const sameDocument: Omit<DocumentFacts, 'index'> = {
            marker: 'same-document',
            navigations: 1,
            shellConnected: true,
            sawSkeleton: false,
          };
          expect(afterBrowserBack).toEqual({ ...sameDocument, index: listIndex });
          expect(afterInAppBack).toEqual({ ...sameDocument, index: reloadedIndex });
          expect(pathAfterInAppBack).toBe(sessionsPathOf(daemon));
          expect(listTop).toBe(1_234);
          expect(Math.abs(listAfterBack - listTop)).toBeLessThanOrEqual(1);
          expect(Math.abs(listAfterReload - listTop)).toBeLessThanOrEqual(1);
          expect(settingsTop).toBe(500);
          expect(Math.abs(settingsAfterBack - settingsTop)).toBeLessThanOrEqual(1);
          expect(Math.abs(settingsAfterReload - settingsTop)).toBeLessThanOrEqual(1);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );

  it(
    'goes Back from a chat to whichever of the home or the list the reader came from, and draws the home from the cache on reload, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange: the front door's home, taken to the list, with the list saved to this profile's cache.
        const { context, tab } = await rig.open(form);
        try {
          const daemon = await boot(rig, tab);
          await cacheSaved(tab, []);
          await markDocument(tab);
          const pathOf = (): string => new URL(tab.url()).pathname;

          // Act: a chat opened off the list, and Back.
          await tab.click(listRow('s-03'));
          await tab.waitForSelector('.fy-transcript');
          await tab.goBack();
          await tab.waitForSelector(listRow('s-03'));
          const backToList = pathOf();

          // Act: a chat opened off the home, Back, then New session off the home and its way back.
          await tab.goBack();
          await tab.waitForSelector('[data-home-ferret="s-00"]');
          await tab.click('[data-home-ferret="s-00"]');
          await tab.waitForSelector('.fy-transcript');
          await tab.goBack();
          await tab.waitForSelector('[data-home-ferret="s-00"]');
          const backToHome = pathOf();
          await tab.click('main a[href$="/new"]');
          await tab.waitForSelector('#new-session-heading');
          const homeWayBack = await tab.$$eval('button', nodes => nodes.some(node => node.textContent === '← Home'));
          await tab.click('button:has-text("← Home")');
          await tab.waitForSelector('[data-home-ferret="s-00"]');
          const afterWayBack = pathOf();
          const sameDocument = await documentFacts(tab);

          // Act: the home reloaded with the daemon's first answer held.
          await nextBoot(tab, { hold: true, renamed: true });
          await tab.goto(`${rig.origin}${homePathOf(daemon)}`);
          await tab.waitForSelector('[data-home-ferret="s-00"]');
          const homeWhileHeld = await tab.$eval('[data-home-ferret="s-00"]', node => (node as HTMLElement).innerText);
          await release(tab);
          await tab.waitForSelector('[data-home-ferret="s-00"] :text("Renamed by the live read")');

          // Assert: Back returns to whichever of the two the reader came from, in the same document, and the
          // home paints the cached ferrets at once, then the live answer.
          expect(backToList).toBe(sessionsPathOf(daemon));
          expect(backToHome).toBe(homePathOf(daemon));
          expect(homeWayBack).toBe(true);
          expect(afterWayBack).toBe(homePathOf(daemon));
          expect(sameDocument).toMatchObject({ marker: 'same-document', navigations: 1, shellConnected: true });
          expect(homeWhileHeld).toContain('Cached relay bench');
          expect(homeWhileHeld).not.toContain('Renamed by the live read');
        } finally {
          await context.close();
        }
      }),
    120_000,
  );

  it(
    'keeps a chat’s reading position, detached, across Back, Forward and a reload, on a desktop and a phone',
    async () =>
      await eachForm(async form => {
        // Arrange: a chat opened at its latest message, then scrolled up by the reader's wheel.
        const { context, tab } = await rig.open(form);
        const transcript = '.fy-transcript';
        try {
          await boot(rig, tab);
          await tab.click(listRow('s-03'));
          await tab.waitForSelector(`${transcript} :text("Live tail of s-03.")`);
          const box = await tab.$eval(transcript, node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          });
          await tab.mouse.move(box.x, box.y);
          for (let step = 0; step < 6; step += 1) await tab.mouse.wheel(0, -400);
          await tab.waitForSelector('.fy-jump-latest');
          await chatPositionRemembered(tab, transcript);
          const reading = await scrollTopOf(tab, transcript);

          // Act: Back to the list, Forward into the chat again.
          await tab.goBack();
          await tab.waitForSelector(listRow('s-03'));
          await tab.goForward();
          await tab.waitForSelector(transcript);
          const afterForward = await settlesAt(tab, transcript, reading);
          const jumpAfterForward = await tab.$$eval('.fy-jump-latest', nodes => nodes.length);

          // Act: and reopened by clicking it, and reloaded.
          await tab.goBack();
          await tab.waitForSelector(listRow('s-03'));
          await tab.click(listRow('s-03'));
          await tab.waitForSelector(transcript);
          const afterClick = await settlesAt(tab, transcript, reading);
          await tab.reload();
          await tab.waitForSelector(`${transcript} :text("Live tail of s-03.")`, { state: 'attached' });
          const afterReload = await settlesAt(tab, transcript, reading);
          const jumpAfterReload = await tab.$$eval('.fy-jump-latest', nodes => nodes.length);

          // Assert: well away from the latest message, and the same place every time.
          const latest = await tab.$eval(transcript, node => node.scrollHeight - node.clientHeight);
          expect(latest - reading).toBeGreaterThan(1_000);
          expect(Math.abs(afterForward - reading)).toBeLessThanOrEqual(1);
          expect(Math.abs(afterClick - reading)).toBeLessThanOrEqual(1);
          expect(Math.abs(afterReload - reading)).toBeLessThanOrEqual(1);
          expect([jumpAfterForward, jumpAfterReload]).toEqual([1, 1]);
        } finally {
          await context.close();
        }
      }),
    120_000,
  );
});
