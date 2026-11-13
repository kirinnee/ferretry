import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { forgetsClosedPages, SurfaceControl } from '../../../daemon/tools/control.ts';
import type { RecordedSurfaceEvent } from '../../../daemon/tools/types.ts';
import { Tabs } from '../../support/tabs.ts';

/** A browser service whose close hook is the daemon's own: a page that closes ends what a person held on it. */
function world() {
  const events: RecordedSurfaceEvent[] = [];
  const sink = {
    publish: async (_session: string, type: string, data: unknown) => {
      events.push({ type, data } as RecordedSurfaceEvent);
    },
    history: async () => events,
  };
  const control = new SurfaceControl(sink, { now: () => 0 });
  const tabs = new Tabs();
  const pages = new BrowserSessionService(
    { get: async () => ({ name: 'fixture' }) },
    { launch: async () => tabs.automation },
    () => 0,
    undefined,
    undefined,
    forgetsClosedPages(control),
  );
  return { control, tabs, pages };
}

/** `forgetsClosedPages` ends a takeover without waiting for its journal write, so a test lets that settle. */
const settled = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) await new Promise<void>(resolve => setImmediate(resolve));
};

describe('a page that closes without the service closing it', () => {
  it('ends the takeover of an unadopted popup when the browser stops', async () => {
    // Arrange — a click opened a popup nobody adopted; a person took it over.
    const { control, tabs, pages } = world();
    const parent = await pages.openPage('s1', 'app');
    tabs.pages.push({ id: 'popup', openerId: parent.id, url: 'about:blank', title: '' });
    await pages.status('s1');
    const popup = { surface: 'browser', id: 'popup' } as const;
    await control.takeover('s1', popup, { by: 'local' });

    // Act
    await pages.closeAll();
    await settled();

    // Assert
    should(await control.takeoverOf('s1', popup)).be.undefined();
  });

  it('ends the takeover of an unadopted popup when the browser crashes', async () => {
    // Arrange
    const { control, tabs, pages } = world();
    const parent = await pages.openPage('s1', 'app');
    tabs.pages.push({ id: 'popup', openerId: parent.id, url: 'about:blank', title: '' });
    await pages.status('s1');
    const popup = { surface: 'browser', id: 'popup' } as const;
    await control.takeover('s1', popup, { by: 'local' });

    // Act
    tabs.die();
    await settled();

    // Assert
    should(await control.takeoverOf('s1', popup)).be.undefined();
  });

  it('ends the takeover of a page that closed inside Chrome, on the next status', async () => {
    // Arrange
    const { control, tabs, pages } = world();
    const parent = await pages.openPage('s1', 'app');
    const surface = { surface: 'browser', id: parent.id } as const;
    await control.takeover('s1', surface, { by: 'local' });
    tabs.pages = tabs.pages.filter(page => page.id !== parent.id);

    // Act
    await pages.status('s1');
    await settled();

    // Assert
    should(await control.takeoverOf('s1', surface)).be.undefined();
  });

  it('ends the ask and the marks of a popup that closed inside Chrome, and keeps the page that did not', async () => {
    // Arrange
    const { control, tabs, pages } = world();
    const parent = await pages.openPage('s1', 'app');
    tabs.pages.push({ id: 'popup', openerId: parent.id, url: 'about:blank', title: '' });
    await pages.status('s1');
    const popup = { surface: 'browser', id: 'popup' } as const;
    const kept = { surface: 'browser', id: parent.id } as const;
    await control.takeover('s1', popup, { by: 'local' });
    await control.asked('s1', popup, {});
    await control.takeover('s1', kept, { by: 'local' });
    tabs.pages = tabs.pages.filter(page => page.id !== 'popup');

    // Act
    await pages.status('s1');
    await settled();

    // Assert
    should(await control.takeoverOf('s1', popup)).be.undefined();
    should((await control.view('s1', 'browser')).asked).deepEqual([]);
    should(await control.takeoverOf('s1', kept)).not.be.undefined();
  });
});
