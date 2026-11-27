import { describe, it } from 'bun:test';
import {
  type BrowserAction,
  type BrowserScreencastFrame,
  BrowserViewerIdSchema,
} from '../../../contract/wire/browser.ts';
import should from 'should';
import {
  type BrowserIdlePolicy,
  type BrowserPageAction,
  BrowserSessionError,
  BrowserSessionService,
  MAX_VIEWERS_PER_SESSION,
  pendingDialogOf,
} from '../../../daemon/pages/service.ts';
import { TypedIdentities } from '../../../daemon/target/sign-in/identities.ts';
import type { ViewerTerminalSignal } from '../../../daemon/stream/viewer-contracts.ts';
import { Tabs } from '../../support/tabs.ts';

const known = new Set(['s1', 's2']);

function harness(tabs = new Tabs(), idle?: BrowserIdlePolicy, signIns?: TypedIdentities) {
  let launches = 0;
  const service = new BrowserSessionService(
    {
      get: async id =>
        known.has(id) ? (id === 's1' ? { name: 'Hadi' } : id === 's2' ? { name: 'Docs' } : {}) : undefined,
    },
    {
      launch: async () => {
        launches += 1;
        return tabs.automation;
      },
    },
    () => Date.parse('2026-10-16T10:00:00.000Z'),
    idle,
    signIns,
  );
  return { tabs, service, launches: () => launches };
}

const failure = async (work: Promise<unknown>): Promise<BrowserSessionError> =>
  (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as BrowserSessionError;

const MAX_VIEWERS = MAX_VIEWERS_PER_SESSION;

/** One screen attaching as one authenticated caller: the attachment carries the viewer the daemon minted for it. */
const attach = async (
  service: BrowserSessionService,
  sessionId: string,
  onFrame: (frame: BrowserScreencastFrame) => void = () => undefined,
  onTerminal: (signal: ViewerTerminalSignal) => void = () => undefined,
  caller = 'admin',
) => {
  const attachment = await service.attachViewer(sessionId, onFrame, onTerminal, caller);
  return { ...attachment, viewer: { id: attachment.viewerId, caller } };
};

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

  it('should close Chrome itself when a stop leaves no session holding a page (fy browser stop, cli-check #37)', async () => {
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');

    const answer = await service.act('s1', { action: 'stop' });

    should(answer.status).match({ state: 'stopped', pages: [] });
    should(tabs.calls).containEql('close');
    should(await service.status('s1')).match({ state: 'stopped' });
  });

  it('should keep Chrome running when a stop lands while another session’s new page is still being opened', async () => {
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    const originalNewPage = tabs.automation.newPage;
    let reply!: () => void;
    const gate = new Promise<void>(resolve => {
      reply = resolve;
    });
    let created!: () => void;
    const entered = new Promise<void>(resolve => {
      created = resolve;
    });
    Object.assign(tabs.automation, {
      newPage: async (options: Parameters<typeof originalNewPage>[0]) => {
        const page = await originalNewPage(options);
        created();
        await gate;
        return page;
      },
    });

    const opening = service.openPage('s2', 'docs');
    await entered;
    await service.act('s1', { action: 'stop' });
    reply();
    await opening;

    should(await service.status('s2')).match({ state: 'running' });
    should((await service.status('s2')).pages.map(page => page.name)).deepEqual(['docs']);
    should(tabs.calls).not.containEql('close');
  });

  it('should not open a page on a browser a stop closed while the open waited its turn', async () => {
    const { service } = harness();
    await service.openPage('s1', 'app');

    const stopping = service.act('s1', { action: 'stop' });
    const opening = failure(service.openPage('s2', 'docs'));
    await stopping;

    // Either the open ran first (and Chrome stayed for it) or it was refused as stopped: never a page on a dead run.
    const refused = await opening;
    if (refused === undefined) should((await service.status('s2')).pages.map(page => page.name)).deepEqual(['docs']);
    else should(refused).match({ code: 'not_running' });
  });

  it('should keep Chrome running for another session when one session stops', async () => {
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    await service.openPage('s2', 'docs');

    const answer = await service.act('s1', { action: 'stop' });

    should(answer.status).match({ state: 'running', pages: [] });
    should(tabs.calls).not.containEql('close');
    should((await service.status('s2')).pages.map(page => page.name)).deepEqual(['docs']);
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
    const attachment = await attach(service, 's1', frame => frames.push(frame));

    // Act — the agent drives its page while the person types into theirs.
    await service.actOnPage('s1', 'app', { action: 'type', selector: '#q', text: 'agent' });
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'hunter2' }, attachment.viewer);
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
    const viewing = await attach(service, 's1', frame => mine.push(frame.pageId));
    await attach(service, 's2', frame => theirs.push(frame.pageId));

    // Act
    await service.act('s1', { action: 'activate-page', pageId: first }, { viewer: viewing.viewer });
    tabs.emit(first);
    tabs.emit(second);

    // Assert
    should(second).not.equal(first);
    should(mine).deepEqual([first]);
    should(theirs).deepEqual([]);
    should((await service.status('s1')).viewers).equal(1);
  });

  it('should drop a person’s input that was meant for a page other than the one the screen is attached to', async () => {
    // Arrange — one screen on the first page; the session then has a second page the screen is moved to
    const { tabs, service } = harness();
    await service.act('s1', { action: 'new-page' });
    const first = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'new-page' });
    const second = activeOf(await service.status('s1'));
    const screen = await attach(service, 's1', () => undefined);
    await service.act('s1', { action: 'activate-page', pageId: second }, { viewer: screen.viewer });

    // Act — the app still painted the first page and typed over it; then it caught up and typed over the second
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'meant for first' }, screen.viewer, first);
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'meant for second' }, screen.viewer, second);

    // Assert — only what was meant for the page the screen is on landed there
    should(tabs.inputs).deepEqual([{ pageId: second, input: { kind: 'insertText', text: 'meant for second' } }]);
    screen.detach();
  });

  it('B1 should give each screen its own page: a tab switch in one screen moves no other screen, its stream or its input', async () => {
    // Arrange — one ferret, two pages, and two screens (a desktop pane and a phone) of the same person.
    const { tabs, service } = harness();
    await service.act('s1', { action: 'new-page' });
    const first = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'new-page' });
    const second = activeOf(await service.status('s1'));
    const desktop: string[] = [];
    const phone: string[] = [];
    const onDesktop = await attach(service, 's1', frame => desktop.push(frame.pageId));
    const onPhone = await attach(service, 's1', frame => phone.push(frame.pageId));

    // Act — the desktop switches to the first page, then every page paints.
    const answer = await service.act('s1', { action: 'activate-page', pageId: first }, { viewer: onDesktop.viewer });
    tabs.emit(first);
    tabs.emit(second);
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'd' }, onDesktop.viewer);
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'p' }, onPhone.viewer);
    await service.act('s1', { action: 'navigate', url: 'https://desk.test/' }, { viewer: onDesktop.viewer });
    await service.act('s1', { action: 'navigate', url: 'https://phone.test/' }, { viewer: onPhone.viewer });

    // Assert — only the desktop moved: its status, stream, typing and toolbar are on the first page; the phone stayed.
    should(onDesktop.viewer.id).not.equal(onPhone.viewer.id);
    should(activeOf((answer as { status: unknown }).status)).equal(first);
    should(activeOf(await service.status('s1', onDesktop.viewer))).equal(first);
    should(activeOf(await service.status('s1', onPhone.viewer))).equal(second);
    should(desktop).deepEqual([first]);
    should(phone).deepEqual([second]);
    should(tabs.inputs).deepEqual([
      { pageId: first, input: { kind: 'insertText', text: 'd' } },
      { pageId: second, input: { kind: 'insertText', text: 'p' } },
    ]);
    should(tabs.calls.slice(-2)).deepEqual([`navigate:${first}`, `navigate:${second}`]);
  });

  it('B1 should leave every screen alone when a call with no screen switches the session’s own view, and the other way round', async () => {
    // Arrange
    const { tabs, service } = harness();
    await service.act('s1', { action: 'new-page' });
    const first = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'new-page' });
    const second = activeOf(await service.status('s1'));
    const screen: string[] = [];
    const onScreen = await attach(service, 's1', frame => screen.push(frame.pageId));

    // Act — `fy browser activate-page` carries no screen; then the screen does the opposite, and back.
    await service.act('s1', { action: 'activate-page', pageId: first });
    tabs.emit(first);
    tabs.emit(second);
    const before = [...screen];
    await service.act('s1', { action: 'activate-page', pageId: first }, { viewer: onScreen.viewer });
    tabs.emit(first);
    tabs.emit(second);
    await service.act('s1', { action: 'activate-page', pageId: second }, { viewer: onScreen.viewer });
    tabs.emit(first);
    tabs.emit(second);

    // Assert
    should(before).deepEqual([second]);
    should(screen).deepEqual([second, first, second]);
    should(activeOf(await service.status('s1'))).equal(first);
    should(activeOf(await service.status('s1', onScreen.viewer))).equal(second);
  });

  it('B1 should start a new screen on the page the session is showing, and end its stream when its own page closes', async () => {
    // Arrange — the session's own view is on the first page; the second is the newest.
    const { service } = harness();
    await service.act('s1', { action: 'new-page' });
    const first = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'new-page' });
    const second = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'activate-page', pageId: first });
    const ended: string[] = [];

    // Act
    const arrival = await attach(service, 's1', undefined, signal => ended.push(signal.reason));
    await service.act('s1', { action: 'activate-page', pageId: second }, { viewer: arrival.viewer });
    await service.act('s1', { action: 'close-page', pageId: second }, { viewer: arrival.viewer });

    // Assert — it arrived where the session was, and when its page closed its stream was told and its selection went.
    should(ended).deepEqual(['the page closed']);
    should(await failure(service.status('s1', arrival.viewer))).match({ code: 'not_found' });
    should(activeOf(await service.status('s1'))).equal(first);
  });

  it('B1 should refuse a caller that presents another caller’s viewer, and leave the selection and the stream where they were', async () => {
    // Arrange — a device's screen on the first page, a second page open.
    const { tabs, service } = harness();
    await service.act('s1', { action: 'new-page' });
    const first = activeOf(await service.status('s1'));
    await service.act('s1', { action: 'new-page' });
    const second = activeOf(await service.status('s1'));
    const frames: string[] = [];
    const mine = await attach(service, 's1', frame => frames.push(frame.pageId), undefined, 'device:phone');
    await service.act('s1', { action: 'activate-page', pageId: first }, { viewer: mine.viewer });
    const stolen = { id: mine.viewer.id, caller: 'device:laptop' };
    const calls = tabs.calls.length;

    // Act — another device and the owner each present the id, to read, to switch, to type and to ask for input.
    const refused = [
      await failure(service.status('s1', stolen)),
      await failure(service.act('s1', { action: 'activate-page', pageId: second }, { viewer: stolen })),
      await failure(service.act('s1', { action: 'navigate', url: 'https://evil.test/' }, { viewer: stolen })),
      await failure(service.dispatchHumanInput('s1', { kind: 'insertText', text: 'x' }, stolen)),
      await failure(service.status('s1', { id: mine.viewer.id, caller: 'admin' })),
      await failure(service.status('s2', mine.viewer)),
    ];
    tabs.emit(first);
    tabs.emit(second);

    // Assert — every one refused alike, nothing ran, and the owner of the viewer still sees and streams its own page.
    for (const error of refused) should(error).match({ code: 'not_found' });
    should(tabs.calls.length).equal(calls);
    should(tabs.inputs).deepEqual([]);
    should(frames).deepEqual([first]);
    should(activeOf(await service.status('s1', mine.viewer))).equal(first);
  });

  it('B1 should mint the viewer id on attach, never take one, and drop the selection with the attachment', async () => {
    // Arrange
    const { service } = harness();
    await service.openPage('s1', 'app');

    // Act
    const one = await attach(service, 's1');
    const two = await attach(service, 's1');
    const status = await service.status('s1', one.viewer);
    one.detach();
    one.detach();
    const gone = await failure(service.status('s1', one.viewer));
    const again = await attach(service, 's1');

    // Assert — each attach is its own plain, unguessable-length id; a detached one is gone; a new attach is a new id.
    should(BrowserViewerIdSchema.safeParse(one.viewer.id).success).be.true();
    should(one.viewer.id).not.equal(two.viewer.id);
    should(one.viewer.id.length).be.aboveOrEqual(32);
    should(status).match({ viewers: 2 });
    should(gone).match({ code: 'not_found' });
    should(again.viewer.id).not.equal(one.viewer.id);
    should((await service.status('s1')).viewers).equal(2);
    should(await service.status('s1', two.viewer)).match({ state: 'running' });
  });

  it('B1 should refuse a new attach when every slot of the session is attached, and never evict an attached viewer', async () => {
    // Arrange — one page, then the session's whole allowance of screens, each streaming it.
    const { tabs, service } = harness();
    const page = await service.openPage('s1', 'app');
    const other = await service.openPage('s1', 'other');
    const seen = new Map<string, string[]>();
    const attached = [];
    for (let each = 0; each < MAX_VIEWERS; each += 1) {
      const frames: string[] = [];
      const one = await attach(service, 's1', frame => frames.push(frame.pageId));
      seen.set(one.viewer.id, frames);
      attached.push(one);
    }

    // Act — one more asks, and is refused; then every screen types and the page paints.
    const refused = await failure(attach(service, 's1'));
    for (const one of attached) await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'k' }, one.viewer);
    tabs.emit(page.id);
    tabs.emit(other.id);

    // Assert — the refusal says why; every attached screen still has its selection, its stream and its input.
    should(refused).match({ code: 'capacity' });
    should(refused.message).match(/screens/u);
    should(tabs.inputs.length).equal(MAX_VIEWERS);
    for (const one of attached) {
      should(await service.status('s1', one.viewer)).match({ state: 'running' });
      should(seen.get(one.viewer.id)).deepEqual([page.id]);
    }
    // A slot freed by a detach is taken by the next screen, and another session is not counted.
    attached[0]?.detach();
    await attach(service, 's1');
    await service.openPage('s2', 'theirs');
    await attach(service, 's2');
  });

  it('B1 should type into the page the stream is showing, even when the session’s own view or an eviction attempt says otherwise', async () => {
    // Arrange — a screen streaming the first page; the session's own view moves to a newer page.
    const { tabs, service } = harness();
    await service.act('s1', { action: 'new-page' });
    const first = activeOf(await service.status('s1'));
    const shown = await attach(service, 's1');
    await service.act('s1', { action: 'new-page' });
    const newest = activeOf(await service.status('s1'));

    // Act — a call with no screen moves the session's view, a full house refuses an attach, and the person types.
    await service.act('s1', { action: 'activate-page', pageId: newest });
    for (let each = 1; each < MAX_VIEWERS; each += 1) await attach(service, 's1');
    await failure(attach(service, 's1'));
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'secret' }, shown.viewer);

    // Assert — it landed on the page the stream was showing, never the newest.
    should(first).not.equal(newest);
    should(tabs.inputs).deepEqual([{ pageId: first, input: { kind: 'insertText', text: 'secret' } }]);
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
    const viewing = await attach(service, 's1', undefined, signal => ended.push(signal.reason));

    // Act
    await service.act('s1', { action: 'close-page', pageId: second });
    const after = await service.status('s1');
    await service.act('s1', { action: 'stop' });

    // Assert
    should(ended).deepEqual(['the page closed']);
    should(activeOf(after)).equal(first);
    should((await service.status('s1')).pages).deepEqual([]);
    should(await failure(service.act('s1', { action: 'click', selector: 'a' }))).match({ code: 'not_running' });
    should(await failure(service.dispatchHumanInput('s1', { kind: 'insertText', text: 'x' }, viewing.viewer))).match({
      code: 'not_running',
    });
    should(await failure(attach(service, 's1'))).match({ code: 'not_running' });
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
    await should(attach(service, 's1')).be.rejectedWith('no frames');
    should((await service.status('s1')).viewers).equal(0);
  });
});

describe('the machine agent browser — its life', () => {
  it('should tell every viewer when the browser stops, or when its worker dies', async () => {
    // Arrange
    const stopped = harness();
    await stopped.service.openPage('s1', 'app');
    const stops: number[] = [];
    await attach(stopped.service, 's1', undefined, signal => stops.push(signal.code));
    const died = harness();
    await died.service.openPage('s1', 'app');
    const deaths: number[] = [];
    await attach(died.service, 's1', undefined, signal => deaths.push(signal.code));

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
    const attachment = await attach(service, 's1');

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

  it('I111 should run the input bridge on the session’s own named page, in its queue, and refuse another session’s', async () => {
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
    const read = await service.copyOnPage('s1', 'app', {
      work: async (copy, pageId) => copy.copyRead(pageId, { kind: 'ref', ref: 'e1' }, 'text'),
    });
    const refused = await failure(service.copyOnPage('s1', other.id, { work: async () => 'reached' }));
    const guarded = await failure(
      service.copyOnPage('s1', 'app', {
        work: async () => 'reached',
        guard: async page => {
          if ((await page.document()) !== undefined) throw new BrowserSessionError('conflict', 'held');
        },
      }),
    );

    // Assert
    should(read).eql({ ok: false, reason: 'empty' });
    should(tabs.calls).containEql(`copyRead:${app.id}`);
    should(refused.code).equal('not_found');
    should(guarded.code).equal('conflict');
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

  it('should let a guard read, from inside the page queue, the host the page is on, or nothing when it cannot', async () => {
    // Arrange — the host a page script is about to run on, as the standing rules' taint reads it (R3c-4).
    const { tabs, service } = harness();
    await service.openPage('s1', 'app');
    tabs.documentHost = 'github.com';
    const seen: (string | undefined)[] = [];
    const guard = async (page: { host?(): Promise<string | undefined> }) => void seen.push(await page.host?.());

    // Act
    await service.actOnPage('s1', 'app', { action: 'back' }, guard);
    tabs.documentFails = true;
    await service.actOnPage('s1', 'app', { action: 'back' }, guard);

    // Assert
    should(seen).eql(['github.com', undefined]);
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

describe('I154 I155 the machine agent browser — who a page signs in (secrev-1331-delta N1)', () => {
  const HOST = 'accounts.google.com';
  /** The browser with the daemon's real record of who each page signs in, the ferret having typed kirinnee97 on `app`. */
  async function signingIn(tabs = new Tabs()) {
    const identities = new TypedIdentities(() => Date.parse('2026-10-16T10:00:00.000Z'));
    const { service } = harness(tabs, undefined, identities);
    const page = await service.openPage('s1', 'app', { url: `https://${HOST}/` });
    await service.act('s1', { action: 'activate-page', pageId: page.id });
    const plant = (): void => identities.typed('s1', page.id, HOST, 'kirinnee97@gmail.com');
    const who = (): string | undefined => identities.at('s1', page.id, HOST);
    plant();
    const live = await attach(service, 's1');
    return { tabs, service, page, plant, who, viewer: live.viewer };
  }

  it('should forget who the page signs in on every toolbar act but a read: the owner’s address bar, a ferret’s fy browser', async () => {
    const { service, plant, who } = await signingIn();
    const cleared: string[] = [];
    const kept: string[] = [];

    const toolbar: BrowserAction[] = [
      { action: 'navigate', url: `https://${HOST}/v3/signin` },
      { action: 'type', selector: '#identifierId', text: 'ernest@atomi.tech' },
      { action: 'click', selector: '[data-email="ernest@atomi.tech"]' },
      { action: 'fill-form', fields: [{ selector: '#identifierId', text: 'ernest@atomi.tech' }] },
      { action: 'press', keys: ['Enter'] },
      { action: 'back' },
      { action: 'forward' },
      { action: 'reload' },
      { action: 'open', url: `https://${HOST}/` },
      { action: 'human-activity', kind: 'pointer' },
      { action: 'read' },
      { action: 'screenshot' },
      { action: 'resize', width: 400, height: 300 },
    ];
    for (const action of toolbar) {
      plant();
      await service.act('s1', action);
      (who() === undefined ? cleared : kept).push(action.action);
    }

    should(cleared).deepEqual([
      'navigate',
      'type',
      'click',
      'fill-form',
      'press',
      'back',
      'forward',
      'reload',
      'open',
      'human-activity',
    ]);
    should(kept).deepEqual(['read', 'screenshot', 'resize']);
    plant();
    await service.act('s1', { action: 'stop' });
    should(who()).be.undefined();
  });

  it('should forget who the session’s pages sign in on a press in the live view, never on a move, a wheel or a release', async () => {
    const { service, plant, who, viewer } = await signingIn();
    const at = { x: 10, y: 10 } as const;

    for (const type of ['mouseMoved', 'mouseWheel', 'mouseReleased'] as const)
      await service.dispatchHumanInput('s1', { kind: 'mouse', type, ...at }, viewer);
    const afterMoves = who();
    // The owner clicks ernest's tile in the account chooser: the "pick the account" hand-off.
    await service.dispatchHumanInput(
      's1',
      { kind: 'mouse', type: 'mousePressed', button: 'left', clickCount: 1, ...at },
      viewer,
    );
    const afterPress = who();
    plant();
    await service.dispatchHumanInput('s1', { kind: 'insertText', text: 'ernest@atomi.tech' }, viewer);

    should(afterMoves).equal('kirinnee97@gmail.com');
    should(afterPress).be.undefined();
    should(who()).be.undefined();
  });

  it('should forget who the page signs in before an agent act that may change it, and keep it through one that cannot', async () => {
    const { service, plant, who } = await signingIn();
    const cleared: string[] = [];
    const kept: string[] = [];

    const acts: BrowserPageAction[] = [
      { action: 'navigate', url: `https://${HOST}/v3/signin` },
      { action: 'type', selector: '#identifierId', text: 'ernest@atomi.tech' },
      { action: 'fill-form', fields: [{ selector: '#identifierId', text: 'ernest@atomi.tech' }] },
      { action: 'press', keys: ['e'] },
      { action: 'click', x: 10, y: 10 },
      { action: 'mouse', mouseAction: 'down', x: 10, y: 10 },
      { action: 'back' },
      { action: 'read' },
      { action: 'screenshot' },
      { action: 'hover', selector: 'a' },
      { action: 'scroll', deltaY: 100 },
      { action: 'press', keys: ['Enter'] },
      { action: 'click', selector: '#identifierNext' },
    ];
    for (const action of acts) {
      plant();
      await service.actOnPage('s1', 'app', action);
      (who() === undefined ? cleared : kept).push(
        `${action.action}${'keys' in action ? `:${action.keys.join('+')}` : ''}`,
      );
    }

    should(cleared).deepEqual(['navigate', 'type', 'fill-form', 'press:e', 'click', 'mouse', 'back']);
    should(kept).deepEqual(['read', 'screenshot', 'hover', 'scroll', 'press:Enter', 'click']);
  });

  it('should forget who the page signs in when an act fails partway, and when a script runs', async () => {
    const tabs = new Tabs();
    const { service, plant, who } = await signingIn(tabs);
    // A fill that typed the email box and then broke on a later field; a click whose page moved and then timed out.
    Object.assign(tabs.automation, {
      pointer: async () => {
        throw new Error('the second field is gone');
      },
      click: async () => {
        throw new Error('the click timed out');
      },
    });

    const fill = await failure(
      service.actOnPage('s1', 'app', {
        action: 'fill-form',
        fields: [
          { selector: '#identifierId', text: 'ernest@atomi.tech' },
          { selector: '#other', text: 'x' },
        ],
      }),
    );
    const afterFill = who();
    plant();
    await failure(service.actOnPage('s1', 'app', { action: 'click', selector: '#identifierNext' }));
    const afterClick = who();
    plant();
    await service.scriptOnPage('s1', 'app', { source: '() => 1' });

    should(fill.message).equal('the second field is gone');
    should(afterFill).be.undefined();
    should(afterClick).be.undefined();
    should(who()).be.undefined();
  });
});
