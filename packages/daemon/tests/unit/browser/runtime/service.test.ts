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
