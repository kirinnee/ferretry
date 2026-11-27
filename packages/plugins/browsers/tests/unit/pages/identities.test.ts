import { describe, it } from 'bun:test';
import should from 'should';
import { BROWSER_MAX_PAGES } from '../../../contract/index.ts';
import { IdentityBrowsers } from '../../../daemon/pages/identities.ts';
import { type BrowserSessionError, BrowserSessionService } from '../../../daemon/pages/service.ts';
import { Tabs } from '../../support/tabs.ts';

const known = new Set(['s1', 's2']);

/** One fake browser per identity, and a record of which identity each launch was asked for. */
function world(maxRunning = 4, gates: { launch?: Promise<void>; close?: Promise<void> } = {}) {
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
    for (const name of ['pg-1', 'work-pg-2'])
      should(await failure(pages.openPage('s1', name))).match({ code: 'conflict' });
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
});
