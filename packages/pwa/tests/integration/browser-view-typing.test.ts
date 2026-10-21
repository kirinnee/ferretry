/**
 * TYPING IN THE BROWSER VIEW, FROM THE KEYBOARD TO A REAL CHROME'S TEXT FIELD.
 *
 * A person reported that some letters ("R") could not be typed into the remote browser. The whole
 * path is production code here: the PWA's own key mapping, the daemon's `BrowserViewerStream`
 * parsing what the socket carries, the browser service and the worker over CDP, in a real
 * headless Chrome. The page reports what it received; the assertion is the exact text.
 *
 * This is the DIRECT carrier (a local socket). The relayed carrier runs the same claim through the
 * real rendezvous in `relay-carrier-end-to-end.test.ts`.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import type { FrameClock } from '../../../daemon/src/lib/browser/transport/contracts.ts';
import { BrowserViewerStream } from '../../../daemon/src/lib/browser/transport/viewer-stream.ts';
import {
  startTypingPage,
  TYPING_SESSION,
  type TypingPage,
  typingReachesThePage,
} from './support/real-chrome-typing.ts';

const clock: FrameClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  },
};

let page: TypingPage;

beforeAll(async () => {
  page = await startTypingPage();
}, 60_000);

afterAll(async () => {
  await page?.close();
});

describe('typing in the remote browser view, over the direct carrier, in a real Chrome', () => {
  it('should deliver every printable key, the editing keys and composed text to the page exactly', async () => {
    const viewer = await BrowserViewerStream.connect(
      page.browser,
      TYPING_SESSION,
      { send: () => undefined, close: () => undefined },
      clock,
    );

    await typingReachesThePage(page, async events => {
      for (const event of events) viewer.fromClient(JSON.stringify(event));
      await viewer.settled;
    });

    viewer.close();
  }, 120_000);
});
