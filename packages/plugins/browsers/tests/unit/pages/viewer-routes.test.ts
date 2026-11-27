import { afterEach, describe, it } from 'bun:test';
import { device, type TestHost } from '@ferretry/kernel/testing';
import should from 'should';
import { BrowserStreamHelloSchema } from '../../../contract/wire/browser.ts';
import { MAX_VIEWERS_PER_SESSION } from '../../../daemon/pages/service.ts';
import { handoverHost } from '../../support/handover-host.ts';

const BROWSER = '/v1/ferrets/f1/browser';
const STREAM = '/v1/ferrets/f1/browser/stream';

const as = (viewer: string) => ({ query: { viewer } });
const activeOf = (body: unknown): string => (body as { activePageId: string }).activePageId;
const jsonOf = (response: { json<T>(): T }) => response.json<{ status: unknown } & Record<string, unknown>>();
/** What the daemon told a stream it is: the first text frame, the only way a viewer id is ever handed out. */
const helloOf = (frames: readonly (string | Uint8Array)[]): string =>
  BrowserStreamHelloSchema.parse(JSON.parse(frames.find(frame => typeof frame === 'string') as string)).viewer;
const pictures = (frames: readonly (string | Uint8Array)[]): number =>
  frames.filter(frame => typeof frame !== 'string').length;

/** B1: one page per screen. The real routes over a fake browser, asked the way two panes, two devices and a ferret ask. */
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
    // Arrange — two screens on one ferret, both showing the newest page; each was told its own id.
    const { host, tabs, first, second } = await world();
    const desktop = await host.socket(STREAM);
    const phone = await host.socket(STREAM);
    const desktopId = helloOf(desktop.frames);
    const phoneId = helloOf(phone.frames);

    // Act
    const switched = await host.request('POST', BROWSER, {
      body: { action: 'activate-page', pageId: first },
      ...as(desktopId),
    });
    tabs.emit(first);
    await drain(host);
    const desktopFrames = pictures(desktop.frames);
    const phoneFrames = pictures(phone.frames);
    tabs.emit(second);
    await drain(host);

    // Assert — the answer, the reads and the pictures follow the desktop alone.
    should(desktopId).not.equal(phoneId);
    should(activeOf(jsonOf(switched).status)).equal(first);
    should(activeOf(jsonOf(await host.request('GET', BROWSER, as(desktopId))))).equal(first);
    should(activeOf(jsonOf(await host.request('GET', BROWSER, as(phoneId))))).equal(second);
    should(activeOf(jsonOf(await host.request('GET', BROWSER)))).equal(second);
    should(desktopFrames).be.above(0);
    should(phoneFrames).equal(0);
    should(pictures(phone.frames)).be.above(0);
    should(pictures(desktop.frames)).equal(desktopFrames);
  });

  it('should never take a viewer id from the client: an id on the stream is ignored and a fresh one is minted', async () => {
    // Arrange
    const { host } = await world();

    // Act
    const chosen = await host.socket(STREAM, as('chosen-by-the-client'));
    const again = await host.socket(STREAM, as('chosen-by-the-client'));

    // Assert
    should(helloOf(chosen.frames)).not.equal('chosen-by-the-client');
    should(helloOf(again.frames)).not.equal(helloOf(chosen.frames));
    should((await host.request('GET', BROWSER, as('chosen-by-the-client'))).status).equal(404);
  });

  it('should refuse a different caller that presents the viewer id, and leave the selection and the stream alone', async () => {
    // Arrange — a phone's screen on the first page, and a second page open.
    const { host, tabs, first, second } = await world();
    const phone = await host.socket(STREAM, { as: device('phone') });
    const id = helloOf(phone.frames);
    await host.request('POST', BROWSER, {
      body: { action: 'activate-page', pageId: first },
      as: device('phone'),
      ...as(id),
    });
    await drain(host);
    const calls = tabs.calls.length;
    const framesBefore = pictures(phone.frames);

    // Act — another device, and the owner, present the phone's id to read it and to retarget it.
    const reads = [
      await host.request('GET', BROWSER, { as: device('laptop'), ...as(id) }),
      await host.request('GET', BROWSER, as(id)),
    ];
    const switches = [
      await host.request('POST', BROWSER, {
        body: { action: 'activate-page', pageId: second },
        as: device('laptop'),
        ...as(id),
      }),
      await host.request('POST', BROWSER, { body: { action: 'activate-page', pageId: second }, ...as(id) }),
    ];
    tabs.emit(first);
    tabs.emit(second);
    await drain(host);

    // Assert — all four refused, nothing was run, the phone still reads and streams its own page.
    for (const response of [...reads, ...switches]) should(response.status).equal(404);
    should(tabs.calls.length).equal(calls);
    should(activeOf(jsonOf(await host.request('GET', BROWSER, { as: device('phone'), ...as(id) })))).equal(first);
    should(pictures(phone.frames)).be.above(framesBefore);
    should(phone.closed).be.undefined();
  });

  it('should leave a ferret’s own acts and reads on the ferret’s own page whatever viewer the call names', async () => {
    // Arrange — the owner's screen is on its own page; a ferret asks with that screen's id, then with a garbled one.
    const { host, tabs, first, as: asFerret } = await world();
    const screen = await host.socket(STREAM);
    const id = helloOf(screen.frames);
    await host.request('POST', BROWSER, { body: { action: 'activate-page', pageId: first }, ...as(id) });
    await drain(host);
    const framesBefore = pictures(screen.frames);

    // Act
    const opened = await host.request('POST', BROWSER, {
      body: { action: 'new-page', url: 'https://ferret.test/' },
      ...asFerret('f1'),
      ...as(id),
    });
    const ferretPage = (tabs.pages.at(-1) as { id: string }).id;
    const read = await host.request('GET', BROWSER, { ...asFerret('f1'), ...as(id) });
    const garbled = await host.request('GET', BROWSER, { ...asFerret('f1'), ...as('a/../b') });
    tabs.emit(ferretPage);
    await drain(host);

    // Assert — the ferret's act and read are on its page, never refused for the viewer; the screen did not move.
    should(opened.status).equal(200);
    should(activeOf(jsonOf(opened).status)).equal(ferretPage);
    should(activeOf(jsonOf(read))).equal(ferretPage);
    should(garbled.status).equal(200);
    should(activeOf(jsonOf(garbled))).equal(ferretPage);
    should(activeOf(jsonOf(await host.request('GET', BROWSER, as(id))))).equal(first);
    should(pictures(screen.frames)).equal(framesBefore);
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

    // Assert
    should(status.status).equal(400);
    should(act.status).equal(400);
    should(tabs.calls.length).equal(calls);
  });

  it('should type into the page the stream shows, and refuse a full house without touching an attached screen', async () => {
    // Arrange — a screen streaming the newest page; then the session's view moves on, and every other slot fills.
    const { host, tabs, first, second } = await world();
    const screen = await host.socket(STREAM);
    const id = helloOf(screen.frames);
    await host.request('POST', BROWSER, { body: { action: 'activate-page', pageId: first } });
    const others = [];
    for (let each = 1; each < MAX_VIEWERS_PER_SESSION; each += 1) others.push(await host.socket(STREAM));

    // Act — one more screen asks, and the person types into the first.
    const refused = await host.socket(STREAM);
    screen.handler?.fromClient(JSON.stringify({ kind: 'insertText', text: 'secret', pageId: second }));
    await drain(host);

    // Assert — the extra screen was refused outright, every attached one is still there, and the text went to the
    // page the stream shows (the second), never the session's view (the first).
    should(refused.response?.status).equal(409);
    should(refused.handler).be.undefined();
    should(tabs.inputs).deepEqual([{ pageId: second, input: { kind: 'insertText', text: 'secret' } }]);
    should((await host.request('GET', BROWSER, as(id))).status).equal(200);
    for (const other of others) should(other.closed).be.undefined();
    should(screen.closed).be.undefined();
  });

  it('should drop the selection when the stream goes, so its id is refused afterwards', async () => {
    // Arrange
    const { host } = await world();
    const screen = await host.socket(STREAM);
    const id = helloOf(screen.frames);
    const live = await host.request('GET', BROWSER, as(id));

    // Act
    screen.handler?.close();
    const gone = await host.request('GET', BROWSER, as(id));

    // Assert
    should(live.status).equal(200);
    should(gone.status).equal(404);
  });
});
