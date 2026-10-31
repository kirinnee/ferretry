/**
 * BACK, RELOAD AND THE SESSION CACHE, in a real browser, through the REAL SHELL — the blocking counterpart
 * of `tests/realworld/shell/nav-cache.visual.test.ts`.
 *
 * The same scene and the same claims, on ONE desktop instead of a desktop and a phone, with no captures.
 * The full matrix (the phone, the dark capture of the held reload) is the realworld file's, because eight
 * cold boots of the real app cost more than a merge gate may spend on one claim; here three profiles run
 * two at a time, and each proves:
 *   1. A reload draws the cached session rows and the cached transcript at once, says "Updating…" while the
 *      daemon's first answer is held, and gives way to the live answer the moment it lands. This device ›
 *      Cached data shows in light and in dark without overflow; once it is cleared, a held reload draws a
 *      skeleton, not old rows.
 *   2. Back — the browser's and the in-app "← Sessions" — returns to the sessions list WITHOUT reloading the
 *      document (a page global survives, the navigation timeline holds one entry, the shell's root node is
 *      the same node), without a skeleton row on the way back, and the list and Settings come back where
 *      they were scrolled after Back and after a reload.
 *   3. A chat scrolled up keeps its reading position, detached with "Jump to latest", across Back, Forward,
 *      a click on its row and a reload.
 */
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { laneTests } from '../support/lanes.ts';
import {
  boot,
  cacheSaved,
  chatPositionRemembered,
  type DocumentFacts,
  documentFacts,
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
} from '../support/nav-cache-rig.ts';

let rig: NavCacheRig;

describe('navigation without reloads, and the session cache, in the real shell (one desktop)', () => {
  beforeAll(async () => {
    rig = await startNavCacheRig();
  }, 180_000);

  afterAll(async () => {
    await rig?.stop();
  });

  const lane = laneTests();

  lane(
    'draws the cached rows and transcript on reload, then the live answer; shows This device › Cached data, light and dark, and forgets the cache when it is cleared: a held reload draws a skeleton',
    async () => {
      // Arrange: one live visit saves the list and s-03's transcript into this profile's IndexedDB.
      const { context, tab } = await rig.open('desktop');
      try {
        const daemon = await boot(rig, tab);
        await tab.click(listRow('s-03'));
        await tab.waitForSelector('.fy-transcript :text("Live tail of s-03.")');
        await cacheSaved(tab, ['s-03']);
        await nextBoot(tab, { hold: true, renamed: true });

        // Act: a reload of the sessions list with the daemon's first answer held.
        await tab.goto(`${rig.origin}${sessionsPathOf(daemon)}`);
        await tab.waitForSelector(listRow('s-00'));
        const cachedList = await tab.$eval(SCROLLER, node => (node as HTMLElement).innerText);
        const pillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
        const skeletonWhileHeld = await tab.$$eval(SKELETON, nodes => nodes.length);
        await release(tab);
        await tab.waitForSelector(`${SCROLLER} :text("Renamed by the live read")`);
        await tab.waitForSelector(PILL, { state: 'detached' });

        // Act: a reload of the chat, held the same way.
        await nextBoot(tab, { hold: true, renamed: true });
        await tab.goto(`${rig.origin}${sessionsPathOf(daemon)}/session/s-03`);
        await tab.waitForSelector('.fy-transcript :text("Live tail of s-03.")');
        const chatPillWhileHeld = await tab.$$eval(PILL, nodes => nodes.length);
        await release(tab);
        await tab.waitForSelector('.fy-transcript :text("Fresh tail of s-03.")');
        await tab.waitForSelector(PILL, { state: 'detached' });
        const staleLinesAfterLive = await tab.$$eval(
          '.fy-transcript :text("Live tail of s-03.")',
          nodes => nodes.length,
        );

        // Act: This device › Cached data, in light and in dark (the theme follows the OS answer live).
        await nextBoot(tab, {});
        await tab.goto(`${rig.origin}${sessionsPathOf(daemon)}/settings#device`);
        await tab.waitForSelector('[data-clear-cached-data="idle"]');
        const sectionFacts: { readonly mode: string; readonly text: string; readonly wide: number }[] = [];
        for (const mode of ['light', 'dark'] as const) {
          await tab.emulateMedia({ colorScheme: mode });
          await tab.$eval('[data-clear-cached-data]', node => node.scrollIntoView({ block: 'center' }));
          sectionFacts.push({
            mode,
            text: await tab.$eval('[data-settings-section="device"]', node => (node as HTMLElement).innerText),
            wide: await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth),
          });
        }
        await tab.emulateMedia({ colorScheme: 'light' });
        // From here on the daemon never answers a list again, so nothing can write the cache back in.
        await stall(tab);

        // Act: clear the cache, then a held reload of the list.
        await tab.click('[data-clear-cached-data] button:has-text("Clear cached data")');
        await tab.click('[data-clear-cached-data="confirming"] button:has-text("Clear")');
        await tab.waitForSelector('[data-clear-cached-data="cleared"]');
        await nextBoot(tab, { hold: true });
        await tab.goto(`${rig.origin}${sessionsPathOf(daemon)}`);
        await tab.waitForSelector(SKELETON);
        const rowsWhileCleared = await tab.$$eval(`${SCROLLER} a[href*="/session/"]`, nodes => nodes.length);
        const pillWhileCleared = await tab.$$eval(PILL, nodes => nodes.length);
        await release(tab);
        await tab.waitForSelector(listRow('s-03'));

        // Assert
        expect(cachedList).toContain('Cached relay bench');
        expect(cachedList).not.toContain('Renamed by the live read');
        expect(pillWhileHeld).toBe(1);
        expect(skeletonWhileHeld).toBe(0);
        expect(chatPillWhileHeld).toBe(1);
        expect(staleLinesAfterLive).toBe(0);
        for (const { mode, text, wide } of sectionFacts) {
          expect(text, `${mode} Cached data section text`).toContain('Cached data');
          expect(wide, `${mode} horizontal overflow`).toBeLessThanOrEqual(0);
        }
        expect(rowsWhileCleared).toBe(0);
        expect(pillWhileCleared).toBe(0);
        expect(await tab.$$eval(SKELETON, nodes => nodes.length)).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  lane(
    'goes Back to the list without reloading the document, and puts Settings and the list back where they were scrolled',
    async () => {
      // Arrange
      const { context, tab } = await rig.open('desktop');
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
        await tab.click(`a[href="${sessionsPathOf(daemon)}/new"]`);
        await tab.waitForSelector('#new-session-heading');
        await tab.click('button:has-text("← Sessions")');
        await tab.waitForSelector(listRow('s-03'));
        const afterInAppBack = await documentFacts(tab);
        const pathAfterInAppBack = new URL(tab.url()).pathname;

        // Act: Settings, out to a session and Back, then reloaded.
        await tab.click(`a[href="${sessionsPathOf(daemon)}/settings"]:visible`);
        await tab.waitForSelector(settings);
        // Behaviour is the longest section.
        await tab.click('[data-settings-section-choice="behaviour"]:visible');
        await tab.waitForFunction(selector => {
          const node = document.querySelector(selector);
          return node !== null && node.scrollHeight > node.clientHeight + 600;
        }, settings);
        const settingsTop = await scrollTo(tab, settings, 500);
        await tab.click('[data-sbar-session="s-05"]');
        await tab.waitForSelector('.fy-transcript');
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
    },
  );

  lane('keeps a chat’s reading position, detached, across Back, Forward and a reload', async () => {
    // Arrange: a chat opened at its latest message, then scrolled up by the reader's wheel.
    const { context, tab } = await rig.open('desktop');
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
  });
});
