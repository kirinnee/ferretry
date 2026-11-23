import { afterEach, describe, it } from 'bun:test';
import type { TestHost } from '@ferretry/kernel/testing';
import should from 'should';
import { handoverHost } from '../../support/handover-host.ts';

const BROWSER = '/v1/ferrets/f1/browser';
const STREAM = '/v1/ferrets/f1/browser/stream';

const as = (viewer: string) => ({ query: { viewer } });
const activeOf = (body: unknown): string => (body as { activePageId: string }).activePageId;
const jsonOf = (response: { json<T>(): T }) => response.json<{ status: unknown } & Record<string, unknown>>();

/** B1: one page per screen. The real routes over a fake browser, asked the way two panes and an older client ask. */
describe('B1 the whole-browser routes and the viewer socket, one page per screen', () => {
  let running: TestHost | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  async function world() {
    const made = await handoverHost();
    running = made.host;
    await made.host.request('POST', BROWSER, { body: { action: 'new-page', url: 'https://one.test/' } });
    const first = (made.tabs.pages.at(-1) as { id: string }).id;
    await made.host.request('POST', BROWSER, { body: { action: 'new-page', url: 'https://two.test/' } });
    const second = (made.tabs.pages.at(-1) as { id: string }).id;
    return { ...made, first, second };
  }

  const drain = async (host: TestHost): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      await host.settle();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  it('should switch only the screen that asked, on the status read, the toolbar and the display', async () => {
    // Arrange — two screens on one ferret, both showing the newest page.
    const { host, tabs, first, second } = await world();
    const desktop = await host.socket(STREAM, as('desktop'));
    const phone = await host.socket(STREAM, as('phone'));

    // Act
    const switched = await host.request('POST', BROWSER, {
      body: { action: 'activate-page', pageId: first },
      ...as('desktop'),
    });
    tabs.emit(first);
    await drain(host);
    const desktopFrames = desktop.frames.length;
    const phoneFrames = phone.frames.length;
    tabs.emit(second);
    await drain(host);

    // Assert — the answer, the reads and the pictures follow the desktop alone.
    should(activeOf(jsonOf(switched).status)).equal(first);
    should(activeOf(jsonOf(await host.request('GET', BROWSER, as('desktop'))))).equal(first);
    should(activeOf(jsonOf(await host.request('GET', BROWSER, as('phone'))))).equal(second);
    should(activeOf(jsonOf(await host.request('GET', BROWSER)))).equal(second);
    should(desktopFrames).be.above(0);
    should(phoneFrames).equal(0);
    should(phone.frames.length).be.above(0);
    should(desktop.frames.length).equal(desktopFrames);
  });

  it('should refuse a viewer id that is not a plain token, before anything is read or run', async () => {
    // Arrange
    const { host, tabs, first } = await world();
    const calls = tabs.calls.length;

    // Act
    const status = await host.request('GET', BROWSER, as('a/../b'));
    const act = await host.request('POST', BROWSER, {
      body: { action: 'activate-page', pageId: first },
      ...as('a b'),
    });
    const stream = await host.socket(STREAM, as('v'.repeat(65)));

    // Assert
    should(status.status).equal(400);
    should(act.status).equal(400);
    should(stream.response?.status).equal(400);
    should(stream.handler).be.undefined();
    should(tabs.calls.length).equal(calls);
  });
});
