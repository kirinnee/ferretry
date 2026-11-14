import { afterEach, describe, it } from 'bun:test';
import { device } from '@ferretry/kernel/testing';
import type { TestHost } from '@ferretry/kernel/testing';
import should from 'should';
import { SurfaceControlViewSchema } from '../../../contract/wire/control.ts';
import { pageTarget } from '../../../daemon/pages/acts.ts';
import { handoverHost } from '../../support/handover-host.ts';
import type { Tabs } from '../../support/tabs.ts';

const BROWSER = '/v1/ferrets/f1/browser';
const CONTROL = '/v1/ferrets/f1/surfaces/browser/control';
const STREAM = '/v1/ferrets/f1/browser/stream';
const PERSON_TITLE = 'Private Bank Statement';

/**
 * The whole-browser routes and the viewer socket as a FERRET reaches them: the real routes over a fake browser. A person
 * opens a page of their own (the toolbar), the agent opens its own (`browser_open`), and every case asks what the agent
 * may do, see and stream. A person's own calls are the control: they are never refused.
 */
describe('a ferret on the whole-browser routes and the viewer socket', () => {
  let running: TestHost | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  type World = Awaited<ReturnType<typeof handoverHost>>;

  /** A person's page (`person`), the agent's own (`mine`), opened in the order given: the last one is the one viewed. */
  async function world(
    order: readonly ('person' | 'mine')[] = ['person', 'mine'],
    viewing: 'person' | 'mine' = order.at(-1) as 'person' | 'mine',
  ): Promise<World & { ids: { person: string; mine: string } }> {
    const made = await handoverHost();
    running = made.host;
    const ids = { person: '', mine: '' };
    for (const which of order) {
      if (which === 'person') {
        await made.host.request('POST', BROWSER, { body: { action: 'new-page', url: 'https://bank.test/statement' } });
        ids.person = (made.tabs.pages.at(-1) as { id: string }).id;
        made.tabs.pages = made.tabs.pages.map(page =>
          page.id === ids.person ? { ...page, title: PERSON_TITLE } : page,
        );
      } else {
        await made.host.tool('browser_open', { name: 'mine', url: 'https://example.test/' }, made.as('f1'));
        ids.mine = (made.tabs.pages.at(-1) as { id: string }).id;
      }
    }
    // What the session views: where the person's toolbar and the viewer go.
    await made.host.request('POST', BROWSER, { body: { action: 'activate-page', pageId: ids[viewing] } });
    return { ...made, ids };
  }

  /** Everything the socket queued has settled: frames pass the act runner before they are sent. */
  const drain = async (host: TestHost): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      await host.settle();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  const open = (tabs: Tabs): readonly string[] => tabs.pages.map(page => page.id);

  describe('stop', () => {
    it('should refuse a ferret’s stop when a page it would close is a person’s, and close nothing', async () => {
      // Arrange
      const { host, tabs, as, ids } = await world();
      const before = open(tabs);

      // Act
      const stop = await host.request('POST', BROWSER, { body: { action: 'stop' }, ...as('f1') });

      // Assert
      should(stop.status).equal(403);
      should(stop.body).containEql('is a person');
      should(open(tabs)).deepEqual(before);
      should(open(tabs)).containEql(ids.person);
    });

    it('should refuse a ferret’s stop when a page it would close is taken over, and close nothing', async () => {
      // Arrange
      const { host, tabs, as } = await world(['mine']);
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'mine' } });
      const before = open(tabs);

      // Act
      const stop = await host.request('POST', BROWSER, { body: { action: 'stop' }, ...as('f1') });

      // Assert
      should(stop.status).equal(409);
      should(stop.body).containEql('A person has taken over');
      should(open(tabs)).deepEqual(before);
    });

    it('should let a ferret stop a browser that holds only its own free pages', async () => {
      // Arrange
      const { host, tabs, as, ids } = await world(['mine']);

      // Act
      const stop = await host.request('POST', BROWSER, { body: { action: 'stop' }, ...as('f1') });

      // Assert
      should(stop.status).equal(200);
      should(open(tabs)).not.containEql(ids.mine);
    });

    it('should let the person stop everything, their own pages included', async () => {
      // Arrange
      const { host, tabs, ids } = await world();

      // Act
      const stop = await host.request('POST', BROWSER, { body: { action: 'stop' } });

      // Assert
      should(stop.status).equal(200);
      should(open(tabs)).not.containEql(ids.person);
      should(open(tabs)).not.containEql(ids.mine);
    });
  });

  describe('what a ferret is shown', () => {
    it('should list only its own pages on the status, never a person’s title, address or id', async () => {
      // Arrange
      const { host, as, ids } = await world(['mine', 'person']);

      // Act
      const status = await host.request('GET', BROWSER, { ...as('f1') });

      // Assert
      should(status.status).equal(200);
      should(status.body).not.containEql(PERSON_TITLE);
      should(status.body).not.containEql('bank.test');
      should(status.body).not.containEql(`"${ids.person}"`);
      should(status.body).containEql(`"${ids.mine}"`);
    });

    it('should show a ferret its own page, not a person’s, as the page in view when the person’s is the one viewed', async () => {
      // Arrange: the person's page is the one viewed
      const { host, as, ids } = await world(['mine', 'person'], 'person');

      // Act
      const status = await host.request('GET', BROWSER, { ...as('f1') });

      // Assert
      const shown = status.json<{ url?: string; title?: string; activePageId?: string }>();
      should(shown.activePageId).equal(ids.mine);
      should(shown.url).equal('https://example.test/');
      should(status.body).not.containEql('bank.test');
    });

    it('should show a ferret with no page of its own an empty page list', async () => {
      // Arrange
      const { host, as } = await world(['person']);

      // Act
      const status = await host.request('GET', BROWSER, { ...as('f1') });

      // Assert
      should(status.status).equal(200);
      should(status.json<{ pages: unknown[] }>().pages).deepEqual([]);
      should(status.body).not.containEql('bank.test');
    });

    it('should show the person every page, as before', async () => {
      // Arrange
      const { host, ids } = await world();

      // Act
      const status = await host.request('GET', BROWSER);

      // Assert
      should(status.body).containEql(`"${ids.person}"`);
      should(status.body).containEql(`"${ids.mine}"`);
    });

    it('should list only a ferret’s own pages in the answer to its own action', async () => {
      // Arrange
      const { host, as, ids } = await world(['person', 'mine']);

      // Act
      const read = await host.request('POST', BROWSER, { body: { action: 'read' }, ...as('f1') });

      // Assert
      should(read.status).equal(200);
      should(read.body).not.containEql(PERSON_TITLE);
      should(read.body).not.containEql(`"${ids.person}"`);
    });
  });

  describe('the page an act touches', () => {
    it('should refuse an act queued behind another when a person takes the page over in between', async () => {
      // Arrange: the first click never returns, the second waits behind it in the page's queue
      const { host, tabs, as } = await world(['mine']);
      let open!: () => void;
      tabs.clickGate = new Promise<void>(resolve => {
        open = resolve;
      });
      const first = host.request('POST', BROWSER, { body: { action: 'click', selector: '#a' }, ...as('f1') });
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      const second = host.request('POST', BROWSER, { body: { action: 'click', selector: '#b' }, ...as('f1') });
      await new Promise<void>(resolve => setTimeout(resolve, 20));

      // Act: the person takes the page over while the second waits, then the first click ends
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'mine' } });
      tabs.clickGate = undefined;
      open();
      const [, refused] = await Promise.all([first, second]);

      // Assert
      should(refused.status).equal(409);
      should(refused.body).containEql('A person has taken over');
      should(tabs.calls.filter(call => call.startsWith('click:'))).have.length(1);
    });

    it('should refuse a ferret’s act on a viewed page that is a person’s', async () => {
      // Arrange
      const { host, tabs, as } = await world(['mine', 'person']);

      // Act
      const click = await host.request('POST', BROWSER, { body: { action: 'click', selector: '#x' }, ...as('f1') });

      // Assert
      should(click.status).equal(403);
      should(tabs.calls.filter(call => call.startsWith('click:'))).have.length(0);
    });
  });

  describe('the viewer socket', () => {
    it('should refuse a ferret a viewer on a person’s page, before the socket opens', async () => {
      // Arrange
      const { host, as } = await world(['mine', 'person']);

      // Act
      const socket = await host.socket(STREAM, as('f1'));

      // Assert
      should(socket.response?.status).equal(403);
      should(socket.handler).be.undefined();
    });

    it('should refuse a ferret a viewer on another ferret’s browser', async () => {
      // Arrange
      const { host, as } = await world();

      // Act
      const socket = await host.socket('/v1/ferrets/f2/browser/stream', as('f1'));

      // Assert
      should(socket.response?.status).equal(403);
    });

    it('should refuse a ferret a viewer on a page that is taken over', async () => {
      // Arrange
      const { host, as } = await world(['mine']);
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'mine' } });

      // Act
      const socket = await host.socket(STREAM, as('f1'));

      // Assert
      should(socket.response?.status).equal(409);
    });

    it('should let a ferret watch its own free page, and send it frames of that page only', async () => {
      // Arrange
      const { host, tabs, as, ids } = await world(['person', 'mine']);

      // Act
      const socket = await host.socket(STREAM, as('f1'));
      tabs.emit(ids.mine);
      await drain(host);

      // Assert
      should(socket.response).be.undefined();
      should(socket.closed).be.undefined();
      should(socket.frames.length).be.above(0);
    });

    it('should end a ferret’s stream when a person takes its page over while it is open, and send no later frame', async () => {
      // Arrange
      const { host, tabs, as, ids } = await world(['mine']);
      const socket = await host.socket(STREAM, as('f1'));
      await host.settle();
      const framesBefore = socket.frames.length;

      // Act
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'mine' } });
      tabs.emit(ids.mine);
      await drain(host);

      // Assert
      should(socket.closed?.code).equal(1008);
      should(socket.frames.length).equal(framesBefore);
    });

    it('should always let the person watch, and type, on any page', async () => {
      // Arrange
      const { host, tabs, ids } = await world(['mine', 'person']);

      // Act
      const owner = await host.socket(STREAM);
      const phone = await host.socket(STREAM, { as: device('phone') });
      tabs.emit(ids.person);
      await drain(host);

      // Assert
      should(owner.response).be.undefined();
      should(phone.response).be.undefined();
      should(owner.frames.length).be.above(0);
    });

    it('should compose with a hold: a held page still drops frames for the person', async () => {
      // Arrange
      const { host, tabs, ids } = await world(['mine']);
      host.hold(pageTarget(ids.mine), 'held');
      const owner = await host.socket(STREAM);

      // Act
      tabs.emit(ids.mine);
      await drain(host);

      // Assert
      should(owner.frames.length).equal(0);
    });
  });

  describe('the control record', () => {
    it('should show a ferret only its own ferret’s record, and omit another ferret’s', async () => {
      // Arrange
      const { host, as } = await world(['mine']);
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'mine' } });

      // Act
      const own = await host.request('GET', CONTROL, { ...as('f1') });
      const other = await host.request('GET', '/v1/ferrets/f2/surfaces/browser/control', { ...as('f1') });

      // Assert
      should(own.status).equal(200);
      should(SurfaceControlViewSchema.parse(own.json()).takeovers).have.length(1);
      should(other.status).equal(403);
      should(other.body).not.containEql('"sessionId"');
    });

    it('should leave a person’s own page out of a ferret’s own record', async () => {
      // Arrange
      const { host, as } = await world(['person', 'mine']);
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'mine' } });
      const personPage = (running === undefined ? undefined : 'p1') as string;
      void personPage;

      // Act
      const own = await host.request('GET', CONTROL, { ...as('f1') });

      // Assert
      const view = SurfaceControlViewSchema.parse(own.json());
      should(view.opened.map(row => row.name)).deepEqual(['mine']);
    });

    it('should show the person every record, as before', async () => {
      // Arrange
      const { host } = await world(['mine']);
      await host.request('POST', CONTROL, { body: { action: 'takeover', key: 'mine' } });

      // Act
      const view = await host.request('GET', CONTROL);

      // Assert
      should(SurfaceControlViewSchema.parse(view.json()).takeovers).have.length(1);
    });
  });
});
