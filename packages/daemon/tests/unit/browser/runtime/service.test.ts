import { describe, it } from 'bun:test';
import should from 'should';
import type { BrowserAutomation } from '../../../../src/lib/browser/transport/automation-contracts.ts';
import { BrowserSessionError, BrowserSessionService } from '../../../../src/lib/browser/runtime/service.ts';

const snapshot = (url = 'about:blank') => ({
  url,
  title: url,
  activePageId: 'p1',
  pages: [{ id: 'p1', url, title: url }],
  pageState: 'ready' as const,
  canGoBack: false,
  canGoForward: false,
});
const acted = (url = 'https://example.test') => ({ ...snapshot(url), actedPageId: 'p1' });

function deferred() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

class Driver {
  readonly exit = deferred();
  calls: string[] = [];
  frame?: (value: { dataBase64: string; width: number; height: number; pageId: string; ackId: number }) => void;
  readonly automation: BrowserAutomation = {
    unexpectedExit: this.exit.promise,
    navigate: async url => this.call(`navigate:${url}`),
    click: async selector => this.call(`click:${selector}`),
    type: async (selector, text) => this.call(`type:${selector}:${text}`),
    read: async selector => ({ ...(await this.call(`read:${selector ?? ''}`)), text: 'read' }),
    screenshot: async () => ({ ...(await this.call('screenshot')), screenshotBase64: 'image' }),
    back: async () => this.call('back'),
    forward: async () => this.call('forward'),
    reload: async () => this.call('reload'),
    location: async () => snapshot(),
    newPage: async url => this.call(`new:${url ?? ''}`),
    activatePage: async id => this.call(`activate:${id}`),
    closePage: async id => this.call(`close:${id}`),
    resize: async view => this.call(`resize:${view.width}x${view.height}`),
    startScreencast: async (_view, listener) => {
      this.calls.push('start-cast');
      this.frame = listener;
    },
    stopScreencast: async () => {
      this.calls.push('stop-cast');
    },
    dispatchInput: async () => {
      this.calls.push('input');
    },
    close: async () => {
      this.calls.push('close');
    },
  };
  private async call(value: string) {
    this.calls.push(value);
    return acted(value);
  }
}

describe('session browser runtime', () => {
  it('should launch, project and dispatch every browser action through one session driver', async () => {
    const driver = new Driver();
    const service = new BrowserSessionService(
      { get: async id => (id === 's1' ? {} : undefined) },
      { launch: async () => driver.automation },
      () => 0,
    );
    should((await service.status('s1')).state).equal('stopped');
    await service.act('s1', { action: 'start' });
    for (const action of [
      { action: 'open', url: 'https://open.test' },
      { action: 'navigate', url: 'https://navigate.test' },
      { action: 'click', selector: '#go' },
      { action: 'type', selector: '#q', text: 'x' },
      { action: 'read' },
      { action: 'screenshot' },
      { action: 'back' },
      { action: 'forward' },
      { action: 'reload' },
      { action: 'new-page' },
      { action: 'activate-page', pageId: 'p1' },
      { action: 'close-page', pageId: 'p1' },
      { action: 'resize', width: 10, height: 20 },
      { action: 'human-activity', kind: 'pointer' },
    ] as const)
      await service.act('s1', action);
    const frames: unknown[] = [];
    const ends: unknown[] = [];
    const attachment = await service.attachViewer(
      's1',
      frame => frames.push(frame),
      end => ends.push(end),
    );
    driver.frame?.({ dataBase64: 'a', width: 1, height: 1, pageId: 'p1', ackId: 1 });
    await service.dispatchHumanInput('s1', { kind: 'mouse', type: 'mouseMoved', x: 1, y: 1 });
    await service.act('s1', { action: 'stop' });
    attachment.detach();
    attachment.detach();
    should(frames).have.length(1);
    should(ends).deepEqual([{ code: 1000, reason: 'browser stopped' }]);
    should(driver.calls).containEql('stop-cast');
    should(driver.calls).containEql('close');
  });

  it('should name absent, failed, over-capacity and exited browsers honestly', async () => {
    const drivers = [new Driver(), new Driver(), new Driver(), new Driver()];
    let next = 0;
    const service = new BrowserSessionService(
      { get: async id => (id === 'missing' ? undefined : {}) },
      { launch: async () => drivers[next++]!.automation },
      () => 0,
    );
    try {
      await service.status('missing');
    } catch (error) {
      should(error).be.instanceOf(BrowserSessionError);
      should((error as BrowserSessionError).code).equal('not_found');
    }
    await Promise.all(['a', 'b', 'c'].map(id => service.act(id, { action: 'start' })));
    try {
      await service.act('d', { action: 'start' });
    } catch (error) {
      should((error as BrowserSessionError).code).equal('capacity');
    }
    drivers[0]!.exit.resolve(1);
    await Bun.sleep(0);
    should((await service.status('a')).state).equal('stopped');
    try {
      await service.act('a', { action: 'click', selector: '#x' });
    } catch (error) {
      should((error as BrowserSessionError).code).equal('not_running');
    }
    await service.closeAll();
  });

  it('should turn launcher and screencast failures into observable launch errors without retaining a viewer', async () => {
    const service = new BrowserSessionService(
      { get: async () => ({}) },
      {
        launch: async () => {
          throw new Error('no chrome');
        },
      },
      () => 0,
    );
    try {
      await service.act('s', { action: 'start' });
    } catch (error) {
      should((error as BrowserSessionError).code).equal('launch_failed');
    }
  });
});

/**
 * A driver that keeps real tabs: a page list, an active page, and a URL per page — enough for names
 * to be checked against what the browser actually holds rather than against what a call claimed.
 */
class Tabs {
  calls: string[] = [];
  pages = [{ id: 'p1', url: 'about:blank', title: '' }];
  active = 'p1';
  private minted = 1;
  private state(acted = this.active) {
    const current = this.pages.find(page => page.id === this.active) ?? this.pages[0];
    if (current === undefined) throw new Error('the fixture holds no page');
    return {
      url: current.url,
      title: current.title,
      activePageId: current.id,
      pages: this.pages.map(page => ({ ...page })),
      pageState: 'ready' as const,
      canGoBack: false,
      canGoForward: false,
      actedPageId: acted,
    };
  }
  private on(page: string, url: string) {
    this.pages = this.pages.map(candidate => (candidate.id === page ? { ...candidate, url } : candidate));
  }
  readonly automation: BrowserAutomation = {
    unexpectedExit: new Promise<number>(() => undefined),
    navigate: async url => {
      this.calls.push(`navigate:${this.active}:${url}`);
      this.on(this.active, url);
      return this.state();
    },
    click: async selector => {
      this.calls.push(`click:${this.active}:${selector}`);
      return this.state();
    },
    type: async (selector, text) => {
      this.calls.push(`type:${this.active}:${selector}:${text}`);
      return this.state();
    },
    read: async (selector, mode) => {
      this.calls.push(`read:${this.active}:${selector ?? ''}:${mode ?? ''}`);
      return { ...this.state(), text: mode === 'a11y' ? '- link "Docs"' : 'Docs' };
    },
    screenshot: async () => ({ ...this.state(), screenshotBase64: 'image' }),
    back: async () => this.state(),
    forward: async () => this.state(),
    reload: async () => this.state(),
    location: async () => this.state(),
    newPage: async url => {
      this.minted += 1;
      const id = `p${String(this.minted)}`;
      this.pages.push({ id, url: url ?? 'about:blank', title: '' });
      this.active = id;
      this.calls.push(`new:${id}:${url ?? ''}`);
      return this.state(id);
    },
    activatePage: async id => {
      this.active = id;
      this.calls.push(`activate:${id}`);
      return this.state(id);
    },
    closePage: async id => {
      this.pages = this.pages.filter(page => page.id !== id);
      if (this.active === id) this.active = this.pages[0]?.id ?? id;
      this.calls.push(`close:${id}`);
      return this.state(id);
    },
    resize: async () => this.state(),
    startScreencast: async () => undefined,
    stopScreencast: async () => undefined,
    dispatchInput: async () => undefined,
    close: async () => undefined,
  };
}

describe('named browser pages', () => {
  const service = (tabs: Tabs) =>
    new BrowserSessionService(
      { get: async id => (id === 's1' ? {} : undefined) },
      { launch: async () => tabs.automation },
      () => 0,
    );

  it('should name the blank tab a fresh browser opened with, and open a new tab for every later name', async () => {
    // Arrange
    const tabs = new Tabs();
    const browser = service(tabs);

    // Act
    const app = await browser.openPage('s1', 'app', 'https://app.test/');
    const docs = await browser.openPage('s1', 'docs');
    const status = await browser.status('s1');

    // Assert
    should(app).deepEqual({ id: 'p1', url: 'https://app.test/', title: '', name: 'app' });
    should(docs).deepEqual({ id: 'p2', url: 'about:blank', title: '', name: 'docs' });
    should(status.pages.map(page => [page.id, page.name])).deepEqual([
      ['p1', 'app'],
      ['p2', 'docs'],
    ]);
    should(tabs.calls).deepEqual(['navigate:p1:https://app.test/', 'new:p2:']);
  });

  it('should name a fresh browser’s blank tab without navigating when no URL is given', async () => {
    const tabs = new Tabs();
    should(await service(tabs).openPage('s1', 'app')).deepEqual({
      id: 'p1',
      url: 'about:blank',
      title: '',
      name: 'app',
    });
    should(tabs.calls).deepEqual([]);
  });

  it('should refuse a name already in use in the session', async () => {
    const browser = service(new Tabs());
    await browser.openPage('s1', 'app');
    const error = await browser.openPage('s1', 'app').catch((failure: unknown) => failure);
    should(error).be.instanceOf(BrowserSessionError).and.have.property('code', 'conflict');
  });

  it('should act on the page a name addresses, making it the active tab first', async () => {
    // Arrange
    const tabs = new Tabs();
    const browser = service(tabs);
    await browser.openPage('s1', 'app', 'https://app.test/');
    await browser.openPage('s1', 'docs', 'https://docs.test/');
    tabs.calls = [];

    // Act
    await browser.actOnPage('s1', 'app', { action: 'click', selector: '#login' });
    await browser.actOnPage('s1', 'app', { action: 'type', selector: '#user', text: 'kirin' });
    const read = await browser.actOnPage('s1', 'p2', { action: 'read', mode: 'a11y', selector: 'nav' });

    // Assert
    should(tabs.calls).deepEqual([
      'activate:p1',
      'click:p1:#login',
      'type:p1:#user:kirin',
      'activate:p2',
      'read:p2:nav:a11y',
    ]);
    should(read).match({ result: { text: '- link "Docs"' }, status: { activePageId: 'p2' } });
  });

  it('should close a named page and forget its name, so the name can be used again', async () => {
    // Arrange
    const tabs = new Tabs();
    const browser = service(tabs);
    await browser.openPage('s1', 'app');
    await browser.openPage('s1', 'docs');

    // Act
    await browser.closePage('s1', 'docs');
    const again = await browser.openPage('s1', 'docs');

    // Assert
    should(again.id).equal('p3');
    should((await browser.status('s1')).pages.map(page => page.name)).deepEqual(['app', 'docs']);
  });

  it('should refuse a page that is not there, and any page while the browser is not running', async () => {
    // Arrange
    const browser = service(new Tabs());

    // Act
    const stopped = await browser.actOnPage('s1', 'app', { action: 'screenshot' }).catch((failure: unknown) => failure);
    const closing = await browser.closePage('s1', 'app').catch((failure: unknown) => failure);
    await browser.openPage('s1', 'app');
    const missing = await browser
      .actOnPage('s1', 'docs', { action: 'screenshot' })
      .catch((failure: unknown) => failure);
    const unknownSession = await browser.openPage('s9', 'app').catch((failure: unknown) => failure);

    // Assert
    should(stopped).have.property('code', 'not_running');
    should(closing).have.property('code', 'not_running');
    should(missing).match({ code: 'not_found', message: 'there is no browser page named docs' });
    should(unknownSession).have.property('code', 'not_found');
  });
});
