import { describe, it } from 'bun:test';
import should from 'should';
import { BROWSER_MAX_PAGES } from '../../../contract/index.ts';
import { IdentityBrowsers } from '../../../daemon/pages/identities.ts';
import { type BrowserSessionError, BrowserSessionService } from '../../../daemon/pages/service.ts';
import { Tabs } from '../../support/tabs.ts';

const known = new Set(['s1', 's2']);

/** One fake browser per identity, and a record of which identity each launch was asked for. */
function world(
  maxRunning = 4,
  gates: { launch?: Promise<void>; close?: Promise<void>; location?: () => Promise<void> } = {},
  configured: (identity: string) => boolean = () => true,
) {
  const browsers = new Map<string, Tabs>();
  const launched: string[] = [];
  const tabsOf = (identity: string): Tabs => {
    let tabs = browsers.get(identity);
    if (tabs === undefined) {
      tabs = new Tabs();
      // Each Chrome numbers its own pages; the suffix keeps two identities' page ids apart, as two real Chromes' are.
      tabs.idSuffix = `-${identity}`;
      browsers.set(identity, tabs);
    }
    return tabs;
  };
  const pages = new IdentityBrowsers({
    maxRunning: () => maxRunning,
    configured,
    make: (identity, quota) =>
      new BrowserSessionService(
        { get: async id => (known.has(id) ? {} : undefined) },
        {
          launch: async (_viewport, named) => {
            launched.push(named ?? 'agent');
            await gates.launch;
            const tabs = tabsOf(named ?? 'agent');
            return {
              ...tabs.automation,
              location: async pageId => {
                await gates.location?.();
                return await tabs.automation.location(pageId);
              },
              close: async () => {
                await gates.close;
                await tabs.automation.close();
              },
            };
          },
        },
        () => Date.parse('2026-11-27T10:00:00.000Z'),
        undefined,
        undefined,
        undefined,
        identity,
        quota,
      ),
  });
  return { pages, tabsOf, launched };
}

const failure = async (work: Promise<unknown>): Promise<BrowserSessionError> =>
  (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as BrowserSessionError;

describe('identity browsers — one Chrome per identity behind the one surface', () => {
  it('should prefer an exact page id over another identity’s page name', async () => {
    const { pages, tabsOf } = world();
    await pages.openPage('s1', 'p1-work');
    const target = await pages.openPage('s1', 'work', { identity: 'work' });
    await pages.actOnPage('s1', target.id, { action: 'click', selector: 'a' });
    should(tabsOf('work').calls).containEql(`click:${target.id}`);
    should(tabsOf('agent').calls.filter(call => call.startsWith('click'))).deepEqual([]);
  });

  it('should reserve every generated id spelling before a future page exists', async () => {
    const { pages } = world();
    for (const name of ['pg-1', 'work-pg-2', 'pg-a', 'work-pg-z', 'work-pg-1a', 'work-2-pg-zz'])
      should(await failure(pages.openPage('s1', name))).match({ code: 'conflict' });
  });

  it('should reserve letter-suffixed page ids for adoption as well as opening', async () => {
    const { pages } = world();
    const unnamed = await pages.act('s1', { action: 'new-page' });
    const key = unnamed.status.pages.at(-1)?.id ?? '';
    for (const name of ['pg-a', 'work-pg-z'])
      should(await failure(pages.adoptPage('s1', key, name))).match({ code: 'conflict' });
  });

  it('should finish closing a driver whose initial snapshot failed before shutdown returns', async () => {
    const snapshot = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const teardown = Promise.withResolvers<void>();
    const { pages, tabsOf } = world(1, {
      location: async () => {
        reading.resolve();
        await snapshot.promise;
      },
      close: teardown.promise,
    });
    const opening = failure(pages.openPage('s1', 'home'));
    await reading.promise;
    let stopped = false;
    const closing = pages.closeAll().then(() => {
      stopped = true;
    });
    snapshot.reject(new Error('injected initial snapshot failure'));
    await Bun.sleep(10);
    const returnedBeforeTeardown = stopped;
    teardown.resolve();
    const [error] = await Promise.all([opening, closing]);
    should(returnedBeforeTeardown).be.false();
    should(error).match({ code: 'launch_failed', message: 'injected initial snapshot failure' });
    should(tabsOf('agent').calls).containEql('close');
    should(pages.runningIdentities()).deepEqual([]);
  });

  it('should reserve a name atomically across concurrent identity opens', async () => {
    const { pages } = world();
    const results = await Promise.allSettled([
      pages.openPage('s1', 'same', { identity: 'one' }),
      pages.openPage('s1', 'same', { identity: 'two' }),
    ]);
    should(results.filter(result => result.status === 'fulfilled')).have.length(1);
  });

  it('should reserve names across adopt and open in different identities', async () => {
    const { pages } = world();
    await pages.openPage('s1', 'home');
    const unnamed = await pages.act('s1', { action: 'new-page' }, { identity: 'work' });
    const key = unnamed.status.pages.at(-1)?.id ?? '';
    const results = await Promise.allSettled([
      pages.adoptPage('s1', key, 'same'),
      pages.openPage('s1', 'same', { identity: 'agent' }),
    ]);
    should(results.filter(result => result.status === 'fulfilled')).have.length(1);
  });

  it('should wait for a pending launch and close its browser before shutdown returns', async () => {
    const gate = Promise.withResolvers<void>();
    const { pages, tabsOf, launched } = world(1, { launch: gate.promise });
    const opening = pages.openPage('s1', 'home');
    while (launched.length === 0) await Bun.sleep(1);
    let closed = false;
    const closing = pages.closeAll().then(() => {
      closed = true;
    });
    await Bun.sleep(10);
    const returnedEarly = closed;
    gate.resolve();
    await Promise.allSettled([opening, closing]);
    should(returnedEarly).be.false();
    should(tabsOf('agent').calls).containEql('close');
    should(pages.runningIdentities()).deepEqual([]);
  });

  it('should keep an identity’s slot until its browser teardown has finished', async () => {
    const gate = Promise.withResolvers<void>();
    const { pages, launched } = world(1, { close: gate.promise });
    await pages.openPage('s1', 'home');
    const closing = pages.act('s1', { action: 'stop' });
    await Bun.sleep(10);
    const opening = pages.openPage('s2', 'work', { identity: 'work' });
    const result = await failure(opening);
    gate.resolve();
    await closing;
    should(result).match({ code: 'capacity' });
    should(launched).deepEqual(['agent']);
    await pages.openPage('s2', 'work', { identity: 'work' });
  });

  it('should start one browser per identity and route every act to the identity that opened the page', async () => {
    // Arrange
    const { pages, tabsOf, launched } = world();

    // Act — the same session opens a page in two identities; a second session in the first.
    const home = await pages.openPage('s1', 'home', { url: 'https://home.test/' });
    const work = await pages.openPage('s1', 'work', { identity: 'work', url: 'https://work.test/' });
    await pages.openPage('s2', 'mine');
    await pages.actOnPage('s1', 'work', { action: 'click', selector: 'a' });
    await pages.actOnPage('s1', 'home', { action: 'click', selector: 'b' });

    // Assert — two launches, one per identity, and each click landed in its own Chrome only.
    should(launched.sort()).deepEqual(['agent', 'work']);
    should(tabsOf('work').calls.filter(call => call.startsWith('click'))).deepEqual([`click:${work.id}`]);
    should(tabsOf('agent').calls.filter(call => call.startsWith('click'))).deepEqual([`click:${home.id}`]);
    should((await pages.status('s1')).pages.map(page => page.name).sort()).deepEqual(['home', 'work']);
    should((await pages.status('s2')).pages.map(page => page.name)).deepEqual(['mine']);
  });

  it('should leave one identity’s pages alive when another identity’s Chrome dies', async () => {
    // Arrange
    const { pages, tabsOf } = world();
    await pages.openPage('s1', 'home');
    await pages.openPage('s1', 'work', { identity: 'work' });

    // Act — the work identity's Chrome crashes.
    tabsOf('work').die();
    await Bun.sleep(20);
    const after = await pages.status('s1');

    // Assert — the default identity's page is still listed and still acted on; the dead one's is gone.
    should(after.pages.map(page => page.name)).deepEqual(['home']);
    await pages.actOnPage('s1', 'home', { action: 'click', selector: 'a' });
    should((await failure(pages.actOnPage('s1', 'work', { action: 'click', selector: 'a' }))).code).equal('not_found');
  });

  it('should stop only the identity that is asked to stop', async () => {
    // Arrange
    const { pages, tabsOf } = world();
    await pages.openPage('s1', 'home');
    await pages.openPage('s2', 'other', { identity: 'work' });

    // Act — s1 stops; it holds a page only in the default identity.
    await pages.act('s1', { action: 'stop' });

    // Assert — the default identity's Chrome closed, the work identity's did not.
    should(tabsOf('agent').calls).containEql('close');
    should(tabsOf('work').calls).not.containEql('close');
    should((await pages.status('s2')).pages.map(page => page.name)).deepEqual(['other']);
  });

  it('should refuse the identity past maxRunning with a sentence naming the ones running', async () => {
    // Arrange
    const { pages, launched } = world(2);
    await pages.openPage('s1', 'a');
    await pages.openPage('s1', 'b', { identity: 'work' });

    // Act
    const refused = await failure(pages.openPage('s1', 'c', { identity: 'shop' }));

    // Assert — plain words, naming who runs; nothing was launched for the third; a running identity is never refused.
    should(refused.code).equal('capacity');
    should(refused.message).match(/agent, work/u);
    should(refused.message).match(/at most 2/u);
    should(launched).not.containEql('shop');
    await pages.openPage('s1', 'd', { identity: 'work' });
  });

  it('should not let two starts asked at once both slip under maxRunning', async () => {
    // Arrange
    const { pages, launched } = world(1);

    // Act — two different identities start at the same moment.
    const settled = await Promise.allSettled([
      pages.openPage('s1', 'a', { identity: 'one' }),
      pages.openPage('s2', 'b', { identity: 'two' }),
    ]);

    // Assert
    should(settled.filter(each => each.status === 'fulfilled')).have.length(1);
    should(launched).have.length(1);
  });

  it('should count the per-session page cap across identities, and keep a page name unique in the session', async () => {
    // Arrange
    const { pages } = world();
    for (let index = 0; index < BROWSER_MAX_PAGES; index += 1)
      await pages.openPage('s1', `p${String(index)}`, index % 2 === 0 ? {} : { identity: 'work' });

    // Act
    const full = await failure(pages.openPage('s1', 'extra', { identity: 'work' }));
    const sameName = await failure(pages.openPage('s1', 'p0', { identity: 'work' }));

    // Assert
    should(full).match({ code: 'capacity' });
    should(sameName).match({ code: 'conflict' });
  });

  it('should refuse an identity key that could not name a profile folder', async () => {
    // Arrange
    const { pages, launched } = world();

    // Act
    const refused = await failure(pages.openPage('s1', 'x', { identity: '../agent' }));

    // Assert
    should(refused).match({ code: 'not_found' });
    should(launched).deepEqual([]);
  });

  it('should refuse an identity the configuration does not name, on every way to open a page, before any Chrome starts', async () => {
    // Arrange — only `work` is configured; `old` is a retired identity whose profile folder may still be on disk
    const { pages, launched } = world(4, {}, identity => identity === 'work');

    // Act
    const opened = await failure(pages.openPage('s1', 'x', { identity: 'old' }));
    const started = await failure(
      pages.act('s1', { action: 'open', url: 'https://example.test/' }, { identity: 'old' }),
    );
    const fresh = await failure(pages.act('s1', { action: 'new-page' }, { identity: 'old' }));

    // Assert
    for (const refused of [opened, started, fresh]) should(refused).match({ code: 'not_found' });
    should(opened.message).containEql('old');
    should(launched).deepEqual([]);
  });

  it('should refuse a new page, an open and a named page for an identity retired since its Chrome stopped, and launch nothing', async () => {
    // Arrange — `work` was configured and in use; its Chrome stops, then it is retired (its profile folder stays on disk)
    const live = new Set(['work']);
    const { pages, launched } = world(4, {}, identity => live.has(identity));
    await pages.openPage('s1', 'work', { identity: 'work' });
    await pages.closeIdentity('work');
    live.delete('work');
    const before = [...launched];

    // Act — none names an identity: the session's remembered one is what they would have gone to
    const fresh = await failure(pages.act('s1', { action: 'new-page' }));
    const opened = await failure(pages.act('s1', { action: 'open', url: 'https://example.test/' }));
    const named = await failure(pages.openPage('s1', 'again'));

    // Assert
    for (const refused of [fresh, opened, named]) should(refused).match({ code: 'not_found' });
    should(launched).deepEqual(before);
  });

  it('should refuse a retired identity even when its Chrome is still up, for a new page', async () => {
    // Arrange
    const live = new Set(['work']);
    const { pages, launched } = world(4, {}, identity => live.has(identity));
    await pages.openPage('s1', 'work', { identity: 'work' });
    live.delete('work');
    const before = [...launched];

    // Act
    const fresh = await failure(pages.act('s1', { action: 'new-page' }));

    // Assert
    should(fresh).match({ code: 'not_found' });
    should(launched).deepEqual(before);
  });

  it('should still open the built-in agent identity and a configured one when the configuration names only the latter', async () => {
    // Arrange
    const { pages, launched } = world(4, {}, identity => identity === 'work');

    // Act
    await pages.openPage('s1', 'home');
    await pages.openPage('s1', 'work', { identity: 'work' });

    // Assert
    should(launched.sort()).deepEqual(['agent', 'work']);
  });

  it('should send a person’s input to the identity whose display it was attached to', async () => {
    // Arrange
    const { pages, tabsOf } = world();
    await pages.openPage('s1', 'home');
    await pages.openPage('s1', 'work', { identity: 'work' });
    const work = await pages.act('s1', {
      action: 'activate-page',
      pageId: (await pages.status('s1')).pages[1]?.id ?? '',
    });
    void work;

    // Act — the screen attaches while the session's last-opened identity is work.
    const attachment = await pages.attachViewer(
      's1',
      () => undefined,
      () => undefined,
      'admin',
    );
    await pages.dispatchHumanInput('s1', { kind: 'key', type: 'keyDown', key: 'a' } as never, {
      id: attachment.viewerId,
      caller: 'admin',
    });

    // Assert — the keystroke reached exactly one Chrome.
    const delivered = ['agent', 'work'].filter(identity => tabsOf(identity).inputs.length > 0);
    should(delivered).have.length(1);
    attachment.detach();
  });

  it('should tell every page which identity’s Chrome holds it', async () => {
    // Arrange
    const { pages } = world();
    await pages.openPage('s1', 'home');
    await pages.openPage('s1', 'work', { identity: 'work' });

    // Act
    const status = await pages.status('s1');

    // Assert
    should(Object.fromEntries(status.pages.map(page => [page.name, page.identity]))).deepEqual({
      home: 'agent',
      work: 'work',
    });
  });

  it('should close one identity’s Chrome and leave every other identity’s pages live', async () => {
    // Arrange
    const { pages, tabsOf } = world();
    await pages.openPage('s1', 'home');
    await pages.openPage('s1', 'work', { identity: 'work' });
    let closed = 0;
    const work = tabsOf('work').automation;
    const close = work.close;
    work.close = async () => {
      closed += 1;
      await close();
    };

    // Act
    await pages.closeIdentity('agent');
    const status = await pages.status('s1');

    // Assert
    should(status.pages.map(page => page.name)).deepEqual(['work']);
    should(closed).equal(0);
  });

  it('should never deliver input meant for the page a screen was on to the page of the identity it was just moved to', async () => {
    // Arrange — the screen is painting the agent's page when the person picks the work identity's page
    const { pages, tabsOf } = world();
    const home = await pages.openPage('s1', 'home', { identity: 'agent' });
    const work = await pages.openPage('s1', 'work', { identity: 'work' });
    const attachment = await pages.attachViewer(
      's1',
      () => undefined,
      () => undefined,
      'admin',
    );
    const viewer = { id: attachment.viewerId, caller: 'admin' };
    const key = { kind: 'key', type: 'keyDown', key: 'a' } as never;

    // Act — the screen moves; input meant for the page it was painting arrives before the app has caught up, then input meant for the new one
    await pages.act('s1', { action: 'activate-page', pageId: work.id }, { viewer });
    await pages.dispatchHumanInput('s1', key, viewer, home.id);
    const reachedWorkEarly = tabsOf('work').inputs.length;
    await pages.dispatchHumanInput('s1', key, viewer, work.id);

    // Assert — the first never reached either Chrome; the second reached the work page only
    should(reachedWorkEarly).equal(0);
    should(tabsOf('agent').inputs).have.length(0);
    should(tabsOf('work').inputs).have.length(1);
    attachment.detach();
  });

  it('should move a screen to the identity that holds the page it is asked to show, and stream that page there', async () => {
    // Arrange — two pages in two identities, the screen starts on the agent's
    const { pages, tabsOf } = world();
    const work = await pages.openPage('s1', 'work', { identity: 'work' });
    const home = await pages.openPage('s1', 'home', { identity: 'agent' });
    const frames: string[] = [];
    const attachment = await pages.attachViewer(
      's1',
      frame => frames.push(frame.pageId ?? ''),
      () => undefined,
      'admin',
    );
    const viewer = { id: attachment.viewerId, caller: 'admin' };
    tabsOf('agent').emit(home.id);

    // Act
    await pages.act('s1', { action: 'activate-page', pageId: work.id }, { viewer });
    const shown = { status: await pages.status('s1', viewer) };
    tabsOf('work').emit(work.id);
    tabsOf('agent').emit(home.id);

    // Assert — the screen is on the other identity's Chrome: its frames come from there, the old one's no longer reach it
    should(frames).deepEqual([home.id, work.id]);
    should('activePageId' in shown.status ? shown.status.activePageId : undefined).equal(work.id);
    should(shown.status.pages.map(page => page.identity).sort()).deepEqual(['agent', 'work']);
    await pages.dispatchHumanInput('s1', { kind: 'key', type: 'keyDown', key: 'a' } as never, viewer);
    should(tabsOf('work').inputs).have.length(1);
    should(tabsOf('agent').inputs).have.length(0);
    attachment.detach();
    should(tabsOf('work').casts.get(work.id)?.size ?? 0).equal(0);
  });
});
