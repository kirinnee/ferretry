import { describe, it } from 'bun:test';
import type {
  BrowserInputEvent,
  BrowserPageActionSnapshot,
  BrowserPageSnapshot,
  BrowserPageSummary,
  BrowserScreencastFrame,
} from '@ferretry/protocol';
import should from 'should';
import {
  type BrowserIdlePolicy,
  type BrowserPageAction,
  BrowserSessionError,
  BrowserSessionService,
  pendingDialogOf,
} from '../../../../src/lib/browser/runtime/service.ts';
import type { BrowserAutomation } from '../../../../src/lib/browser/transport/automation-contracts.ts';

type Page = BrowserPageSummary & { pageState?: 'ready' | 'error' };

/**
 * The machine's agent browser, faked with REAL tabs and no active one: every act names its page,
 * every screencast streams one page, every input lands on the page it names. What a test reads back
 * is what each page received — so cross-talk between a person's tab and an agent's would show.
 */
class Tabs {
  readonly calls: string[] = [];
  readonly inputs: { readonly pageId: string; readonly input: BrowserInputEvent }[] = [];
  readonly casts = new Map<string, Set<(frame: BrowserScreencastFrame) => void>>();
  pages: Page[] = [{ id: 'p0', url: 'about:blank', title: '' }];
  castFailure: Error | undefined;
  /** A dialog the worker reports on the page of every result, as a worker with a dialog open does. */
  dialog: { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string } | undefined;
  /** The browser cannot say which document a page shows. */
  documentFails = false;
  /** While set, a click does not return: the page's queue is stuck behind it, as it is behind a dialog. */
  clickGate: Promise<void> | undefined;
  private minted = 0;
  private exited!: (code: number) => void;
  readonly exit = new Promise<number>(resolve => {
    this.exited = resolve;
  });

  die(): void {
    this.exited(1);
  }

  /** Streams one frame from a page to whoever watches that page. */
  emit(pageId: string): void {
    for (const listener of this.casts.get(pageId) ?? []) listener({ dataBase64: 'AAAA', width: 1, height: 1, pageId });
  }

  private state(pageId?: string): BrowserPageSnapshot {
    const page = this.pages.find(candidate => candidate.id === pageId) ?? (this.pages[0] as Page);
    return {
      url: page.url,
      title: page.title,
      pages: this.pages.map(({ pageState: _state, ...summary }) => summary),
      activePageId: page.id,
      pageState: page.pageState ?? 'ready',
      ...(page.pageState === 'error' ? { pageError: 'it broke' } : {}),
      canGoBack: page.pageState !== 'error',
      canGoForward: false,
    };
  }

  private acted(method: string, pageId: string): BrowserPageActionSnapshot {
    this.calls.push(`${method}:${pageId}`);
    return { ...this.state(pageId), actedPageId: pageId };
  }

  readonly automation: BrowserAutomation = {
    unexpectedExit: this.exit,
    navigate: async (pageId, url) => {
      this.pages = this.pages.map(page => (page.id === pageId ? { ...page, url } : page));
      return this.acted('navigate', pageId);
    },
    click: async pageId => {
      await this.clickGate;
      return { ...this.acted('click', pageId), ...(this.dialog === undefined ? {} : { dialog: this.dialog }) };
    },
    type: async pageId => this.acted('type', pageId),
    pointer: async (pageId, act) => this.acted(`pointer-${act.action}`, pageId),
    read: async (pageId, options) => ({ ...this.acted(`read-${options?.mode ?? 'text'}`, pageId), text: 'hello' }),
    screenshot: async pageId => ({ ...this.acted('screenshot', pageId), screenshotBase64: 'iVBOR' }),
    upload: async pageId => this.acted('upload', pageId),
    download: async pageId => ({
      ...this.acted('download', pageId),
      staged: { path: '/stage/dl-1', name: 'report.csv', size: 3 },
    }),
    pdf: async pageId => ({
      ...this.acted('pdf', pageId),
      staged: { path: '/stage/pdf-1', name: 'page.pdf', size: 5 },
    }),
    evaluate: async (pageId, script) => ({ ...this.acted('evaluate', pageId), text: `ran:${script.source}` }),
    back: async pageId => this.acted('back', pageId),
    forward: async pageId => this.acted('forward', pageId),
    reload: async pageId => this.acted('reload', pageId),
    location: async pageId => this.state(pageId),
    copyRead: async pageId => {
      this.calls.push(`copyRead:${pageId}`);
      return { ok: false, reason: 'empty' };
    },
    inputDocument: async pageId => {
      this.calls.push(`inputDocument:${pageId}`);
      if (this.documentFails) throw new Error('the page is gone');
      return { navigationId: 'loader-1' };
    },
    inputObserve: async pageId => {
      this.calls.push(`inputObserve:${pageId}`);
      return { ok: false, missing: 'value' };
    },
    inputShot: async pageId => {
      this.calls.push(`inputShot:${pageId}`);
      return { pngBase64: 'AAAA', clip: { x: 0, y: 0, w: 1, h: 1 } };
    },
    inputType: async pageId => {
      this.calls.push(`inputType:${pageId}`);
      return 'typed';
    },
    newPage: async options => {
      this.minted += 1;
      const id = `p${String(this.minted)}`;
      this.pages.push({
        id,
        url: options.url ?? 'about:blank',
        title: '',
        ...(options.incognito === true ? { incognito: true } : {}),
      });
      return this.acted(`new${options.incognito === true ? '-incognito' : ''}`, id);
    },
    closePage: async pageId => {
      this.pages = this.pages.filter(page => page.id !== pageId);
      this.casts.delete(pageId);
      return { ...this.state(), actedPageId: pageId };
    },
    resize: async (pageId, viewport) => this.acted(`resize-${String(viewport.width)}`, pageId),
    lifecycle: async (pageId, request) => ({
      ...this.acted(`lifecycle-${request.op}`, pageId),
      ...(this.dialog === undefined ? {} : { dialog: this.dialog }),
      lifecycle: { text: `did ${request.op}`, ...(request.op === 'wait' ? { matched: true } : {}) },
    }),
    startScreencast: async (pageId, _viewport, listener) => {
      if (this.castFailure !== undefined) throw this.castFailure;
      const set = this.casts.get(pageId) ?? new Set();
      set.add(listener);
      this.casts.set(pageId, set);
    },
    stopScreencast: async (pageId, listener) => {
      this.casts.get(pageId)?.delete(listener);
    },
    dispatchInput: async (pageId, input) => {
      this.inputs.push({ pageId, input });
    },
    close: async () => {
      this.calls.push('close');
    },
  };
}

const known = new Set(['s1', 's2']);

function harness(tabs = new Tabs(), idle?: BrowserIdlePolicy) {
  let launches = 0;
  const service = new BrowserSessionService(
    {
      get: async id =>
        known.has(id)
          ? id === 's1'
            ? { config: { name: 'Fix the login page', teammate: 'hadi' } }
            : id === 's2'
              ? { config: { name: 'Docs' } }
              : {}
          : undefined,
    },
    {
      launch: async () => {
        launches += 1;
        return tabs.automation;
      },
    },
    () => Date.parse('2026-10-16T10:00:00.000Z'),
    idle,
  );
  return { tabs, service, launches: () => launches };
}

const failure = async (work: Promise<unknown>): Promise<BrowserSessionError> =>
  (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as BrowserSessionError;

describe('the machine agent browser — one Chrome, pages by session', () => {
  it('should start one browser for every session, and show each session only its own pages', async () => {
    // Arrange
    const { service, launches } = harness();

    // Act — two sessions open pages at once: one launch serves both.
    const [app, docs] = await Promise.all([
      service.openPage('s1', 'app', { url: 'https://app.test/', openedBy: { by: 'agent', sessionId: 's1' } }),
      service.openPage('s2', 'docs', { incognito: true }),
    ]);
    const mine = await service.status('s1');
    const theirs = await service.status('s2');

    // Assert
    should(launches()).equal(1);
    should(app).match({ name: 'app', openedBy: { by: 'agent', sessionId: 's1' }, url: 'https://app.test/' });
    should(docs).match({ name: 'docs', incognito: true });
    should(mine.pages.map(page => page.name)).deepEqual(['app']);
    should(theirs.pages.map(page => page.name)).deepEqual(['docs']);
    should(mine).match({ state: 'running', activePageId: app.id, url: 'https://app.test/', canGoBack: true });
    // Every page names the session it belongs to, and that session's display name when it has one.
    should(mine.pages[0]).match({ ownerSessionId: 's1', ownerName: 'Hadi' });
    // …its task title when it has no first name.
    should(theirs.pages[0]).match({ ownerSessionId: 's2', ownerName: 'Docs' });
    // Chrome's own first tab belongs to nobody, so it is in nobody's listing.
    should(mine.pages.some(page => page.id === 'p0')).be.false();
  });

  it('should act on the named page and nothing else, and never on another session’s page', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    const other = await service.openPage('s2', 'app');

    // Act
    for (const action of [
      { action: 'navigate', url: 'https://x.test/' },
      { action: 'click', selector: 'a' },
      { action: 'type', selector: '#q', text: 'x' },
      { action: 'read', mode: 'a11y' },
      { action: 'screenshot' },
    ] as const)
      await service.actOnPage('s1', 'app', action);
    const pointerActions: BrowserPageAction[] = [
      { action: 'hover', ref: 'e1' },
      { action: 'drag', fromRef: 'e1', toRef: 'e2' },
      { action: 'mouse', mouseAction: 'up' },
      { action: 'press', keys: ['Enter'] },
      { action: 'scroll', pages: 1 },
      { action: 'select', ref: 'e1', values: ['a'] },
      { action: 'check', ref: 'e1', checked: true },
      { action: 'fill-form', fields: [{ ref: 'e1', text: 'a' }] },
      { action: 'highlight', clear: true },
    ];
    for (const action of pointerActions) await service.actOnPage('s1', 'app', action);
    const foreign = await failure(service.actOnPage('s1', other.id, { action: 'click', selector: 'a' }));

    // Assert — every act went to s1's page; s2's page of the same name was never touched.
    should(tabs.calls.filter(call => !call.startsWith('new'))).deepEqual([
      `navigate:${app.id}`,
      `click:${app.id}`,
      `type:${app.id}`,
      `read-a11y:${app.id}`,
      `screenshot:${app.id}`,
      ...['hover', 'drag', 'mouse', 'press', 'scroll', 'select', 'check', 'fill-form', 'highlight'].map(
        kind => `pointer-${kind}:${app.id}`,
      ),
    ]);
    should(foreign).match({ code: 'not_found' });
  });

  it('should show the proxy the browser started with, and nothing about one it did not', async () => {
    // Arrange
    const direct = harness();
    const tabs = new Tabs();
    const proxy = { url: 'http://proxy.example:8080', authenticated: true, bypassCount: 1 };
    Object.assign(tabs.automation, { proxy });
    const proxied = harness(tabs);
    await direct.service.openPage('s1', 'app');
    await proxied.service.openPage('s1', 'app');

    // Act
    const through = await proxied.service.status('s1');
    const goes = await direct.service.status('s1');

    // Assert
    should(through).have.property('proxy').eql(proxy);
    should(goes).not.have.property('proxy');
  });

  it('should describe the machine browser as a whole: stopped, then running with its proxy, then stopped again', async () => {
    // Arrange
    const tabs = new Tabs();
    const proxy = { url: 'http://proxy.example:8080', authenticated: true, bypassCount: 0 };
    Object.assign(tabs.automation, { proxy });
    const { service } = harness(tabs);

    // Act
    const before = service.overview();
    await service.openPage('s1', 'app');
    const during = service.overview();
    await service.closeAll();
    const after = service.overview();

    // Assert
    should(before).eql({ state: 'stopped' });
    should(during).eql({ state: 'running', startedAt: '2026-10-16T10:00:00.000Z', proxy });
    should(after).eql({ state: 'stopped' });
  });

  it('should let a guard refuse an act from inside the page’s own queue', async () => {
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    const refused = await failure(
      service.actOnPage('s1', 'app', { action: 'click', selector: 'a' }, async () => {
        throw new BrowserSessionError('conflict', 'a person holds it');
      }),
    );
    should(refused.message).equal('a person holds it');
    should(tabs.calls.filter(call => call.startsWith('click'))).deepEqual([]);
  });

  it('should run the file tools on the named page, return what the worker staged, and keep the page list current', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');

    // Act
    const uploaded = await service.filesOnPage('s1', 'app', {
      action: 'upload',
      target: { kind: 'selector', selector: '#f' },
      paths: ['/upload/0'],
      mode: 'input',
    });
    const downloaded = await service.filesOnPage('s1', 'app', { action: 'download' });
    const printed = await service.filesOnPage('s1', app.id, { action: 'pdf' });

    // Assert
    should(tabs.calls.filter(call => !call.startsWith('new'))).deepEqual([
      `upload:${app.id}`,
      `download:${app.id}`,
      `pdf:${app.id}`,
    ]);
    should(uploaded.staged).be.undefined();
    should(downloaded.staged).deepEqual({ path: '/stage/dl-1', name: 'report.csv', size: 3 });
    should(printed.staged).deepEqual({ path: '/stage/pdf-1', name: 'page.pdf', size: 5 });
    should(printed.result).not.have.property('staged');
    should(printed.status.pages.map(page => page.id)).containEql(app.id);
  });

  it('should keep one session’s file tools off another session’s page, and refuse a page that is not there', async () => {
    const { tabs, service } = harness();
    const other = await service.openPage('s2', 'app');
    await service.openPage('s1', 'mine');

    const foreign = await failure(service.filesOnPage('s1', other.id, { action: 'pdf' }));
    const missing = await failure(service.filesOnPage('s1', 'nope', { action: 'download' }));

    should(foreign).match({ code: 'not_found' });
    should(missing).match({ code: 'not_found' });
    should(tabs.calls.filter(call => call.startsWith('pdf') || call.startsWith('download'))).deepEqual([]);
  });

  it('should let a guard refuse a file act from inside the page’s queue, before the browser is touched', async () => {
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');

    const refused = await failure(
      service.filesOnPage('s1', 'app', { action: 'pdf' }, async () => {
        throw new BrowserSessionError('conflict', 'a person holds it');
      }),
    );

    should(refused.message).equal('a person holds it');
    should(tabs.calls.filter(call => call.startsWith('pdf'))).deepEqual([]);
  });

  it('should run a page script on the named page, behind its guard, and keep it off another session’s page', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    const other = await service.openPage('s2', 'theirs');

    // Act
    const ran = await service.scriptOnPage('s1', 'app', { source: '() => 1', target: { kind: 'ref', ref: 'e1' } });
    const foreign = await failure(service.scriptOnPage('s1', other.id, { source: '() => 1' }));
    const guarded = await failure(
      service.scriptOnPage('s1', 'app', { source: '() => 2' }, async () => {
        throw new BrowserSessionError('conflict', 'a person holds it');
      }),
    );

    // Assert
    should(ran.text).equal('ran:() => 1');
    should(ran.result).not.have.property('text');
    should(ran.status.pages.map(page => page.id)).containEql(app.id);
    should(foreign).match({ code: 'not_found' });
    should(guarded.message).equal('a person holds it');
    should(tabs.calls.filter(call => call.startsWith('evaluate'))).deepEqual([`evaluate:${app.id}`]);
  });

  it('should refuse a name in use, and a page past the session’s or the machine’s cap — never hide it', async () => {
    // Arrange
    const { service } = harness();
    await service.openPage('s1', 'app');

    // Act
    const taken = await failure(service.openPage('s1', 'app'));
    for (let page = 1; page < 20; page += 1) await service.openPage('s1', `p-${String(page)}`);
    const sessionFull = await failure(service.openPage('s1', 'one-more'));
    for (let page = 0; page < 20; page += 1) await service.openPage('s2', `a-${String(page)}`);
    known.add('s3');
    for (let page = 0; page < 20; page += 1) await service.openPage('s3', `b-${String(page)}`);
    known.add('s4');
    const machineFull = await failure(service.openPage('s4', 'first'));

    // Assert
    should(taken.code).equal('conflict');
    should(sessionFull).match({ code: 'capacity', message: /this session already has 20 browser pages open/u });
    should(machineFull).match({ code: 'capacity', message: /this machine's browser already has 60 pages open/u });
    should((await service.status('s1')).pages).have.length(20);
  });

  it('should count a popup as its opener’s session’s page', async () => {
    // Arrange — a click in s1's page opened a popup (the browser reports its opener).
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    tabs.pages.push({ id: 'popup', url: 'https://pop.test/', title: '', openerId: app.id });
    tabs.pages.push({ id: 'stray', url: 'https://x.test/', title: '', openerId: 'gone' });

    // Act
    const pages = (await service.status('s1')).pages.map(page => page.id);
    const viaPopup = await service.actOnPage('s1', 'popup', { action: 'screenshot' });

    // Assert
    should(pages).deepEqual([app.id, 'popup']);
    should(viaPopup.status).match({ sessionId: 's1' });
    should((await service.status('s1')).pages[1]).match({ id: 'popup', ownerSessionId: 's1', ownerName: 'Hadi' });
    should((await service.status('s2')).pages).deepEqual([]);
  });

  it('should count the popups an agent’s clicks opened toward the machine’s cap', async () => {
    // Arrange — 50 pages opened by name, and 10 popups those pages opened: 60 session pages.
    const { tabs, service } = harness();
    known.add('s5');
    const first = await service.openPage('s1', 'app');
    for (let page = 1; page < 20; page += 1) await service.openPage('s1', `p-${String(page)}`);
    for (let page = 0; page < 20; page += 1) await service.openPage('s2', `a-${String(page)}`);
    for (let page = 0; page < 10; page += 1) await service.openPage('s5', `b-${String(page)}`);
    for (let page = 0; page < 10; page += 1)
      tabs.pages.push({ id: `pop-${String(page)}`, url: 'https://pop.test/', title: '', openerId: first.id });

    // Act
    const refused = await failure(service.openPage('s5', 'one-more'));

    // Assert
    should(refused).match({ code: 'capacity', message: /this machine's browser already has 60 pages open/u });
    should((await service.status('s5')).capacity).deepEqual({ running: 60, maximum: 60 });
  });

  it('should close a page by name, and close every page of a session that ended', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    await service.openPage('s1', 'secret', { incognito: true });
    await service.openPage('s2', 'docs');

    // Act
    await service.closePage('s1', 'app');
    const afterClose = await service.status('s1');
    await service.releaseSession('s1');
    await service.releaseSession('s9');

    // Assert — the incognito page closed with the session; s2 kept its page.
    should(afterClose.pages.map(page => page.name)).deepEqual(['secret']);
    should((await service.status('s1')).pages).deepEqual([]);
    should((await service.status('s2')).pages.map(page => page.name)).deepEqual(['docs']);
    should(tabs.pages.some(page => page.incognito === true)).be.false();
  });

  it('should release nothing, and report stopped, when the browser is not running', async () => {
    const { service } = harness();
    await service.releaseSession('s1');
    should(await service.status('s1')).match({ state: 'stopped', pages: [], idleTimeoutSeconds: 0 });
    should(await failure(service.actOnPage('s1', 'app', { action: 'screenshot' }))).match({ code: 'not_running' });
    should(await failure(service.closePage('s1', 'app'))).match({ code: 'not_running' });
    should(await failure(service.status('s9'))).match({ code: 'not_found' });
  });
});

describe('the machine agent browser — a person and an agent at once', () => {
  it('should stream only the page a person is viewing, and land their input there while the agent works elsewhere', async () => {
    // Arrange — the agent's page and the person's page, both in session s1.
    const { tabs, service } = harness();
    await service.act('s1', { action: 'new-page', url: 'https://bank.test/' });
    const persons = activeOf(await service.status('s1'));
    const agents = await service.openPage('s1', 'app', { openedBy: { by: 'agent', sessionId: 's1' } });
    const frames: BrowserScreencastFrame[] = [];
    const attachment = await service.attachViewer(
      's1',
      frame => frames.push(frame),
      () => undefined,
    );

    // Act — the agent drives its page while the person types into theirs.
    await service.actOnPage('s1', 'app', { action: 'type', selector: '#q', text: 'agent' });
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'hunter2' });
    tabs.emit(agents.id);
    tabs.emit(persons);

    // Assert — no cross-talk either way, and the agent's act moved nothing.
    should(tabs.inputs).deepEqual([{ pageId: persons, input: { kind: 'insertText', text: 'hunter2' } }]);
    should(tabs.calls).containEql(`type:${agents.id}`);
    should(frames.map(frame => frame.pageId)).deepEqual([persons]);
    should(activeOf(await service.status('s1'))).equal(persons);
    attachment.detach();
    attachment.detach();
  });

  it('should move a person’s view and live stream when they switch tabs, and keep sessions’ viewers apart', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.act('s1', { action: 'start' });
    const first = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'new-page' });
    const second = activeOf(await service.status('s1'));
    await service.openPage('s2', 'theirs');
    const mine: string[] = [];
    const theirs: string[] = [];
    await service.attachViewer(
      's1',
      frame => mine.push(frame.pageId),
      () => undefined,
    );
    await service.attachViewer(
      's2',
      frame => theirs.push(frame.pageId),
      () => undefined,
    );

    // Act
    await service.act('s1', { action: 'activate-page', pageId: first });
    tabs.emit(first);
    tabs.emit(second);

    // Assert
    should(second).not.equal(first);
    should(mine).deepEqual([first]);
    should(theirs).deepEqual([]);
    should((await service.status('s1')).viewers).equal(1);
  });

  it('should drive the person’s toolbar on the page they view', async () => {
    // Arrange
    const { tabs, service } = harness();
    const started = await service.act('s1', { action: 'open', url: 'https://one.test/' });
    const viewed = activeOf(await service.status('s1'));

    // Act
    await service.act('s1', { action: 'open', url: 'https://two.test/' });
    await service.act('s1', { action: 'open' });
    await service.act('s1', { action: 'start' });
    for (const action of [
      { action: 'navigate', url: 'https://three.test/' },
      { action: 'click', selector: 'a' },
      { action: 'type', selector: 'a', text: 'b' },
      { action: 'read' },
      { action: 'screenshot' },
      { action: 'back' },
      { action: 'forward' },
      { action: 'reload' },
      { action: 'resize', width: 400, height: 300 },
      { action: 'human-activity', kind: 'pointer' },
    ] as const)
      await service.act('s1', action);
    const status = await service.status('s1');

    // Assert
    should(started).match({ status: { url: 'https://one.test/' } });
    should(tabs.calls.slice(1)).deepEqual([
      `navigate:${viewed}`,
      `navigate:${viewed}`,
      `click:${viewed}`,
      `type:${viewed}`,
      `read-text:${viewed}`,
      `screenshot:${viewed}`,
      `back:${viewed}`,
      `forward:${viewed}`,
      `reload:${viewed}`,
      `resize-400:${viewed}`,
    ]);
    should(status.viewport).deepEqual({ width: 400, height: 300 });
  });

  it('should close a viewed page, end its stream, and fall back to the session’s next page', async () => {
    // Arrange
    const { service } = harness();
    await service.act('s1', { action: 'new-page' });
    const first = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'new-page' });
    const second = activeOf(await service.status('s1'));
    const ended: string[] = [];
    await service.attachViewer(
      's1',
      () => undefined,
      signal => ended.push(signal.reason),
    );

    // Act
    await service.act('s1', { action: 'close-page', pageId: second });
    const after = await service.status('s1');
    await service.act('s1', { action: 'stop' });

    // Assert
    should(ended).deepEqual(['the page closed']);
    should(activeOf(after)).equal(first);
    should((await service.status('s1')).pages).deepEqual([]);
    should(await failure(service.act('s1', { action: 'click', selector: 'a' }))).match({ code: 'not_running' });
    should(await failure(service.dispatchHumanInput('s1', { kind: 'insertText', text: 'x' }))).match({
      code: 'not_running',
    });
    should(
      await failure(
        service.attachViewer(
          's1',
          () => undefined,
          () => undefined,
        ),
      ),
    ).match({ code: 'not_running' });
  });

  it('should move a person’s view to the session’s newest page when the page they viewed vanished from the browser', async () => {
    // Arrange — the person's tab is closed inside Chrome itself, not through this service.
    const { tabs, service } = harness();
    const viewed = await service.openPage('s1', 'viewed');
    const survivor = await service.openPage('s1', 'survivor');
    tabs.pages = tabs.pages.filter(page => page.id !== viewed.id);

    // Act
    const status = await service.status('s1');
    await service.act('s1', { action: 'screenshot' });

    // Assert — the session is shown, and next acts on, the page that is still there.
    should(activeOf(status)).equal(survivor.id);
    should(tabs.calls.at(-1)).equal(`screenshot:${survivor.id}`);
  });

  it('should describe a page it last saw in error, and only the page it last described', async () => {
    const { tabs, service } = harness();
    await service.act('s1', { action: 'new-page' });
    const viewed = activeOf(await service.status('s1'));
    tabs.pages = tabs.pages.map(page => (page.id === viewed ? { ...page, pageState: 'error' } : page));
    should(await service.status('s1')).match({ pageState: 'error', pageError: 'it broke', canGoBack: false });
  });

  it('should refuse a viewer whose stream would not start, keeping nothing behind', async () => {
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    tabs.castFailure = new Error('no frames');
    await should(
      service.attachViewer(
        's1',
        () => undefined,
        () => undefined,
      ),
    ).be.rejectedWith('no frames');
    should((await service.status('s1')).viewers).equal(0);
  });
});

describe('the machine agent browser — its life', () => {
  it('should tell every viewer when the browser stops, or when its worker dies', async () => {
    // Arrange
    const stopped = harness();
    await stopped.service.openPage('s1', 'app');
    const stops: number[] = [];
    await stopped.service.attachViewer(
      's1',
      () => undefined,
      signal => stops.push(signal.code),
    );
    const died = harness();
    await died.service.openPage('s1', 'app');
    const deaths: number[] = [];
    await died.service.attachViewer(
      's1',
      () => undefined,
      signal => deaths.push(signal.code),
    );

    // Act
    await stopped.service.closeAll();
    await stopped.service.closeAll();
    died.tabs.die();
    await Bun.sleep(0);

    // Assert
    should(stops).deepEqual([1000]);
    should(stopped.tabs.calls).containEql('close');
    should(deaths).deepEqual([1011]);
    should(await died.service.status('s1')).match({ state: 'stopped' });
  });

  it('should start a fresh browser on the next need after its worker dies, never reuse the dead one', async () => {
    // A worker that dies takes Chrome's DevTools pipe with it, and a pipe cannot be reattached: the only
    // recovery is a new Chrome and a new worker, started by whatever needs the browser next.
    // Arrange
    const launched: Tabs[] = [];
    const service = new BrowserSessionService(
      { get: async id => (known.has(id) ? {} : undefined) },
      {
        launch: async () => {
          const tabs = new Tabs();
          launched.push(tabs);
          return tabs.automation;
        },
      },
      () => Date.parse('2026-10-16T10:00:00.000Z'),
    );
    await service.openPage('s1', 'app');

    // Act
    (launched[0] as Tabs).die();
    await Bun.sleep(0);
    const stopped = await service.status('s1');
    const reopened = await service.openPage('s1', 'app');

    // Assert — stopped in between, then a second launch serves the page; the dead browser is never asked.
    should(stopped).match({ state: 'stopped' });
    should(launched).have.length(2);
    should(reopened).match({ name: 'app' });
    should((launched[1] as Tabs).calls.some(call => call.startsWith('new'))).be.true();
    should(await service.status('s1')).match({ state: 'running' });
  });

  it('should name a launch failure, passing the browser’s own refusal through', async () => {
    const plain = new BrowserSessionService(
      { get: async () => ({}) },
      {
        launch: async () => {
          throw new Error('Chrome is not installed');
        },
      },
      () => 0,
    );
    const own = new BrowserSessionService(
      { get: async () => ({}) },
      {
        launch: async () => {
          throw new BrowserSessionError('capacity', 'busy');
        },
      },
      () => 0,
    );
    const odd = new BrowserSessionService(
      { get: async () => ({}) },
      {
        launch: async () => {
          throw 'a string';
        },
      },
      () => 0,
    );
    should(await failure(plain.openPage('s1', 'app'))).match({
      code: 'launch_failed',
      message: 'Chrome is not installed',
    });
    should(await failure(own.openPage('s1', 'app'))).match({ code: 'capacity' });
    should(await failure(odd.openPage('s1', 'app'))).match({ code: 'launch_failed', message: 'browser launch failed' });
  });

  it('should stop the browser after it sat idle with nobody watching, and wait while somebody is', async () => {
    // Arrange — a timer the test fires by hand.
    const timers: (() => void)[] = [];
    const idle: BrowserIdlePolicy = {
      timeoutMs: 600_000,
      after: (_milliseconds, action) => {
        timers.push(action);
        return { cancel: () => undefined };
      },
    };
    const { tabs, service } = harness(new Tabs(), idle);
    await service.openPage('s1', 'app');
    const attachment = await service.attachViewer(
      's1',
      () => undefined,
      () => undefined,
    );

    // Act — the clock runs out with a viewer: nothing stops. Then without one: the browser stops.
    (timers.at(-1) as () => void)();
    const watched = await service.status('s1');
    attachment.detach();
    (timers.at(-1) as () => void)();
    await Bun.sleep(0);
    timers[0]?.();

    // Assert
    should(watched).match({ state: 'running', idleTimeoutSeconds: 600 });
    should(tabs.calls).containEql('close');
    should(await service.status('s1')).match({ state: 'stopped', idleTimeoutSeconds: 600 });
  });
});

/** The page a running status says its person is viewing. */
function activeOf(status: unknown): string {
  return (status as { readonly activePageId: string }).activePageId;
}

describe('the machine agent browser — a page’s lifecycle', () => {
  it('should answer a dialog and read the logs without waiting for the act the dialog is blocking', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    let release: () => void = () => undefined;
    tabs.clickGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const stuck = service.actOnPage('s1', 'app', { action: 'click', selector: 'button' });
    await Promise.resolve();

    // Act
    const dialog = await service.lifecycleOnPage('s1', 'app', { op: 'dialog', action: 'accept' });
    const logs = await service.lifecycleOnPage('s1', 'app', { op: 'console' });
    const requests = await service.lifecycleOnPage('s1', 'app', { op: 'network', action: 'list' });
    release();
    await stuck;

    // Assert
    should(dialog.reply.text).equal('did dialog');
    should(logs.reply.text).equal('did console');
    should(requests.reply.text).equal('did network');
    should(tabs.calls).containEql(`lifecycle-dialog:${app.id}`);
  });

  it('should queue a wait and an emulation behind the page’s other work', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    let release: () => void = () => undefined;
    tabs.clickGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const stuck = service.actOnPage('s1', 'app', { action: 'click', selector: 'button' });
    await Promise.resolve();

    // Act
    const waiting = service.lifecycleOnPage('s1', 'app', {
      op: 'wait',
      condition: { kind: 'load', state: 'load' },
      timeoutMs: 500,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const before = tabs.calls.filter(call => call.startsWith('lifecycle'));
    release();
    await stuck;
    const outcome = await waiting;

    // Assert
    should(before).deepEqual([]);
    should(outcome.reply).deepEqual({ text: 'did wait', matched: true });
  });

  it('should let a guard refuse a lifecycle request, queued or not', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    const guard = async (): Promise<void> => {
      throw new BrowserSessionError('conflict', 'a person holds it');
    };

    // Act
    const dialog = await failure(service.lifecycleOnPage('s1', 'app', { op: 'dialog', action: 'dismiss' }, guard));
    const wait = await failure(
      service.lifecycleOnPage('s1', 'app', { op: 'wait', condition: { kind: 'time', ms: 5 }, timeoutMs: 100 }, guard),
    );

    // Assert
    should(dialog.message).equal('a person holds it');
    should(wait.message).equal('a person holds it');
    should(tabs.calls.filter(call => call.startsWith('lifecycle'))).deepEqual([]);
  });

  it('should run the input bridge on the session’s own named page, in its queue, and refuse another session’s', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    const other = await service.openPage('s2', 'app');

    // Act
    const answered = await service.inputOnPage('s1', 'app', async (fields, pageId) => {
      await fields.inputDocument(pageId);
      return pageId;
    });
    const refused = await failure(service.inputOnPage('s1', other.id, async () => 'reached'));

    // Assert
    should(answered).equal(app.id);
    should(tabs.calls).containEql(`inputDocument:${app.id}`);
    should(refused.code).equal('not_found');
  });

  it('should read a secure copy on the session’s own named page, in its queue, and refuse another session’s', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    const other = await service.openPage('s2', 'app');

    // Act
    const read = await service.copyOnPage('s1', 'app', async (copy, pageId) =>
      copy.copyRead(pageId, { kind: 'ref', ref: 'e1' }, 'text'),
    );
    const refused = await failure(service.copyOnPage('s1', other.id, async () => 'reached'));

    // Assert
    should(read).eql({ ok: false, reason: 'empty' });
    should(tabs.calls).containEql(`copyRead:${app.id}`);
    should(refused.code).equal('not_found');
  });

  it('should let a guard read, from inside the page queue, which document the page shows, or nothing when it cannot', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    const seen: (string | undefined)[] = [];
    const guard = async (page: { document(): Promise<string | undefined> }) => void seen.push(await page.document());

    // Act
    await service.actOnPage('s1', 'app', { action: 'back' }, guard);
    tabs.documentFails = true;
    await service.actOnPage('s1', 'app', { action: 'back' }, guard);

    // Assert
    should(seen).eql(['loader-1', undefined]);
  });

  it('should refuse a lifecycle request on a page of another session', async () => {
    // Arrange
    const { service } = harness();
    const other = await service.openPage('s2', 'app');

    // Act
    const refused = await failure(service.lifecycleOnPage('s1', other.id, { op: 'console' }));

    // Assert
    should(refused.code).equal('not_found');
  });

  it('should hand the dialog a lifecycle request left pending back to the agent’s service', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    tabs.dialog = { type: 'confirm', message: 'Leave the page?' };

    // Act
    const outcome = await service.lifecycleOnPage('s1', 'app', { op: 'console' });

    // Assert
    should(outcome.dialog).deepEqual({ type: 'confirm', message: 'Leave the page?' });
  });

  it('should keep a dialog off the person’s response but on the agent’s', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    tabs.dialog = { type: 'alert', message: 'Saved' };

    // Act
    const agents = await service.actOnPage('s1', 'app', { action: 'click', selector: 'a' });
    const person = await service.act('s1', { action: 'click', selector: 'a' });

    // Assert
    const resultOf = (response: object): unknown => ('result' in response ? response.result : undefined);
    should(pendingDialogOf(resultOf(agents))).deepEqual({ type: 'alert', message: 'Saved' });
    should(pendingDialogOf(resultOf(person))).be.undefined();
    should(resultOf(person)).not.have.property('dialog');
  });

  it('should pass an emulated viewport and a reset through to the worker', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');

    // Act
    await service.lifecycleOnPage('s1', 'app', { op: 'emulate', emulation: { viewport: { width: 390, height: 844 } } });
    await service.lifecycleOnPage('s1', 'app', { op: 'emulate', emulation: { reset: true } });

    // Assert
    should(tabs.calls.filter(call => call.startsWith('lifecycle-emulate'))).have.length(2);
  });

  it('should name an unnamed popup and credit the agent that adopted it', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    tabs.pages.push({ id: 'popup', url: 'https://pop.test/', title: '', openerId: app.id });

    // Act
    const adopted = await service.adoptPage('s1', 'popup', 'checkout', { by: 'agent', sessionId: 's1' });
    const listed = (await service.status('s1')).pages.find(page => page.id === 'popup');
    const again = await failure(service.adoptPage('s1', 'popup', 'other'));
    const taken = await failure(service.adoptPage('s1', 'p0', 'app'));

    // Assert
    should(adopted).match({ id: 'popup', name: 'checkout', openedBy: { by: 'agent', sessionId: 's1' } });
    should(listed).match({ name: 'checkout', openerId: app.id });
    should(again.code).equal('conflict');
    should(taken.code).equal('not_found');
  });

  it('should refuse to adopt a page to a name this session already uses', async () => {
    // Arrange
    const { tabs, service } = harness();
    const app = await service.openPage('s1', 'app');
    tabs.pages.push({ id: 'popup', url: 'https://pop.test/', title: '', openerId: app.id });

    // Act
    const taken = await failure(service.adoptPage('s1', 'popup', 'app'));

    // Assert
    should(taken.code).equal('conflict');
  });
});
