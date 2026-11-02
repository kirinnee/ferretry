import { describe, it } from 'bun:test';
import should from 'should';
import type { ActedPage } from '../../../src/lib/input-requests/login-observer.ts';
import { agent, agentToolWorld } from './support.ts';

/**
 * EVERY ACT IS PLACED ON THE PAGE IT TOUCHED (&B137 C): the login observer is told before an act runs, and once the call
 * is over, which page it was (its id and context) and every host it was on around the act, so a page card's lock reads
 * only acts on its own page (login-observer.ts `pageSteer`).
 */

function world() {
  const told: { kind: string; script: boolean; page?: ActedPage | 'unplaced' }[] = [];
  const w = agentToolWorld({
    loginActs: {
      acted: (_sessionId, kind, script) => {
        const entry: (typeof told)[number] = { kind, script, page: 'unplaced' };
        told.push(entry);
        return {
          placed: page => {
            if (page === undefined) delete entry.page;
            else entry.page = page;
          },
        };
      },
    },
  });
  return { ...w, told };
}

describe('the page each act of the ferret is placed on', () => {
  it('should place an open on the new page at the host it opened, and an incognito one as incognito', async () => {
    // Arrange
    const w = world();

    // Act
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/signin' });
    await w.service.call(agent, {
      tool: 'browser.open',
      name: 'other',
      url: 'https://accounts.google.com/signin',
      incognito: true,
    });

    // Assert
    should(w.told).deepEqual([
      { kind: 'browser', script: false, page: { id: 'page-1', hosts: ['accounts.google.com'] } },
      { kind: 'browser', script: false, page: { id: 'page-2', incognito: true, hosts: ['accounts.google.com'] } },
    ]);
  });

  it('should place an act on the page it named, with where it was, where it ended and where its popups are', async () => {
    // Arrange
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/signin' });
    w.browser.popup('s1', 'page-1');

    // Act — the click moves the page on (inside the page's queue, after the page was looked up).
    w.browser.beforeGuard.push(() => {
      w.browser.pages.set(
        's1',
        (w.browser.pages.get('s1') ?? []).map(page =>
          page.id === 'page-1' ? { ...page, url: 'https://myaccount.google.com/' } : page,
        ),
      );
    });
    await w.service.call(agent, { tool: 'browser.click', name: 'app', ref: 'e1' });

    // Assert
    should(w.told.at(-1)).deepEqual({
      kind: 'browser',
      script: false,
      page: { id: 'page-1', hosts: ['accounts.google.com', 'myaccount.google.com', 'popup.test'] },
    });
  });

  it('should place a script like any act, and say it is one', async () => {
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/signin' });
    await w.service.call(agent, { tool: 'browser.eval', name: 'app', function: '() => 1' });
    should(w.told.at(-1)).deepEqual({
      kind: 'browser',
      script: true,
      page: { id: 'page-1', hosts: ['accounts.google.com'] },
    });
  });

  it('should leave an act on every page when its page or its hosts cannot be told', async () => {
    // Arrange
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/signin' });
    w.browser.pages.set(
      's1',
      (w.browser.pages.get('s1') ?? []).map(page => ({ ...page, url: 'data:text/html,hi' })),
    );

    // Act — a page with no host to read, and a page that is not there.
    await w.service.call(agent, { tool: 'browser.click', name: 'app', ref: 'e1' });
    await w.service.call(agent, { tool: 'browser.click', name: 'nowhere', ref: 'e1' }).catch(() => undefined);

    // Assert — every host of page-1, then every page.
    should(w.told.slice(1)).deepEqual([
      { kind: 'browser', script: false, page: { id: 'page-1' } },
      { kind: 'browser', script: false },
    ]);
  });

  it('should tell nothing for a read, and place a terminal act on no page', async () => {
    const w = world();
    await w.service.call(agent, { tool: 'browser.open', name: 'app', url: 'https://accounts.google.com/signin' });
    await w.service.call(agent, { tool: 'browser.read', name: 'app' });
    await w.service.call(agent, { tool: 'terminal.open', name: 'dev' });
    should(w.told.slice(1)).deepEqual([{ kind: 'terminal', script: false }]);
  });
});
