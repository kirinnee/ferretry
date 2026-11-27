import { expect, it } from 'bun:test';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { BrowserCapture } from '../../../daemon/worker/capture/index.ts';

async function withCapture(work: (page: Page, session: CDPSession, capture: BrowserCapture) => Promise<void>) {
  const browser = await chromium.launch({
    executablePath: Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent('<!doctype html><input id="field" type="text">');
    const sessions = new Map<Page, CDPSession>();
    const capture = new BrowserCapture(
      async target => {
        let session = sessions.get(target);
        if (!session) {
          session = await context.newCDPSession(target);
          sessions.set(target, session);
        }
        return session;
      },
      async () => {
        throw new Error('a stale native frame must be withheld');
      },
      work => work,
      () => Date.now(),
    );
    const session = await context.newCDPSession(page);
    sessions.set(page, session);
    await work(page, session, capture);
  } finally {
    await browser.close();
  }
}

it('withholds a rendered transient secret even after the field is cleared before receipt', async () => {
  await withCapture(async (page, session, capture) => {
    // Prime a clean scan before the transient state, as a preceding screencast frame would.
    await capture.frame(page, 'preceding-frame', Date.now() / 1000).catch(() => undefined);
    await page.evaluate(() => {
      const field = document.querySelector('input');
      if (!field) throw new Error('fixture field missing');
      field.type = 'password';
      field.value = 'synthetic-vault-transient-482913';
      field.type = 'text';
    });
    const image = await session.send('Page.captureScreenshot', { format: 'jpeg' });
    const renderedAt = Date.now() / 1000;
    await page.locator('input').fill('');
    // The later selector scan is clean, but cannot authorize these earlier rendered pixels.
    await expect(capture.frame(page, image.data, renderedAt)).rejects.toThrow();
  });
}, 15_000);

it('primes before the first real screencast frame of a static clean page', async () => {
  await withCapture(async (page, session, capture) => {
    await capture.prepareFrames(page);
    const first = new Promise<{ data: string; sessionId: number; metadata: { timestamp?: number } }>(resolve => {
      session.once('Page.screencastFrame', resolve);
    });
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 50 });
    const event = await first;
    try {
      expect(await capture.frame(page, event.data, event.metadata.timestamp)).toBe(event.data);
    } finally {
      await session.send('Page.screencastFrameAck', { sessionId: event.sessionId });
      await session.send('Page.stopScreencast');
    }
  });
}, 15_000);
