import { describe, it } from 'bun:test';
import {
  type BrowserAction,
  type BrowserActionResult,
  BrowserActionResultSchema,
  BrowserLoginStatusSchema,
  type BrowserPageSnapshot,
  type BrowserStatus,
  BrowserStatusSchema,
  SocketTicketResponseSchema,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { ApiSocketDispatcher, type SocketDownstream, type SocketHandler } from '../../../../src/lib/api/socket.ts';
import { SocketTicketRegistry } from '../../../../src/lib/api/socket-ticket.ts';
import { BrowserControlError } from '../../../../src/lib/browser/control/index.ts';
import { BrowserSessionError } from '../../../../src/lib/browser/runtime/index.ts';
import {
  type BrowserMountedSubsystem,
  browserLoginRoutes,
  browserSocketRoutes,
} from '../../../../src/lib/runtime/mounts/browser-login.ts';
import { jsonBody, request } from '../../api/support.ts';
import { BrokenBrowserLogin, CREDENTIALS, FakeBrowserLogin, GRANTED, human, NO_TICKETS } from './support.ts';

/**
 * The human browser-login route, over a window with no host behind it.
 *
 * Every assertion here is about the TRANSPORT: which intents reach the lifecycle, what a refusal
 * becomes on the wire, and who is allowed to ask. `BrowserLoginWindowService` itself — the state
 * machine, the teardown ordering, the profile lease — is proved in the integration tier against a
 * fake runtime, and the runtime adapter against fake executables.
 */

const warden = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;

const dispatcherFor = (window: FakeBrowserLogin | BrokenBrowserLogin): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(browserLoginRoutes(window)), CREDENTIALS, GRANTED);

const post = (body: unknown) =>
  request({ method: 'POST', path: '/v1/browser/login', headers: human, body: JSON.stringify(body) });

describe('the mounted browser-login window', () => {
  it('should answer a read with a status the reader can parse', async () => {
    // Arrange
    const window = new FakeBrowserLogin();

    // Act
    const response = await dispatcherFor(window).dispatch(request({ path: '/v1/browser/login', headers: human }));

    // Assert
    should(response.status).equal(200);
    // The reader parses this with the protocol schema, so the mount is held to it here.
    should(BrowserLoginStatusSchema.parse(JSON.parse(String(response.body)))).deepEqual({
      state: 'closed',
      profilePrimed: false,
    });
    should(window.calls).deepEqual(['status']);
    // The status of an OPEN window carries a live VNC password, so it must never be cacheable.
    should(response.headers?.get('cache-control')).equal('no-store');
  });

  it('should carry each explicit human intent through to the lifecycle', async () => {
    // Arrange
    const window = new FakeBrowserLogin();
    const dispatcher = dispatcherFor(window);

    // Act
    const started = await dispatcher.dispatch(post({ action: 'start', minutes: 30 }));
    const confirmed = await dispatcher.dispatch(post({ action: 'confirm' }));
    const stopped = await dispatcher.dispatch(post({ action: 'stop', primed: true }));

    // Assert
    should([started.status, confirmed.status, stopped.status]).deepEqual([200, 200, 200]);
    should(window.calls).deepEqual(['start:30', 'confirm', 'stop:true']);
    // The window a person signed into reports itself primed, which is the whole artefact.
    should(BrowserLoginStatusSchema.parse(JSON.parse(String(stopped.body)))).deepEqual({
      state: 'closed',
      profilePrimed: true,
    });
    should(BrowserLoginStatusSchema.parse(JSON.parse(String(started.body))).state).equal('open');
  });

  it('should omit an unstated duration and an unstated verdict rather than inventing one', async () => {
    // A `start` with no minutes must reach the domain's own default, and a `stop` with no `primed` must
    // not be read as "the human said no". Passing `undefined` explicitly would be the same value here
    // but a different contract: the domain's optional-parameter defaults are what decide both.
    // Arrange
    const window = new FakeBrowserLogin();
    const dispatcher = dispatcherFor(window);

    // Act
    await dispatcher.dispatch(post({ action: 'start' }));
    await dispatcher.dispatch(post({ action: 'stop' }));

    // Assert
    should(window.calls).deepEqual(['start:default', 'stop:unstated']);
  });

  it('should refuse a body the action schema rejects before the lifecycle is touched', async () => {
    // Arrange
    const window = new FakeBrowserLogin();
    const dispatcher = dispatcherFor(window);

    // Act
    const unknown = await dispatcher.dispatch(post({ action: 'restart' }));
    const tooLong = await dispatcher.dispatch(post({ action: 'start', minutes: 600 }));

    // Assert
    should(unknown.status).equal(400);
    should(tooLong.status).equal(400);
    // Nothing was opened: an unparseable intent is not a lifecycle call.
    should(window.calls).deepEqual([]);
  });

  it('should answer an unusable request with 400 and a window it cannot serve with 503', async () => {
    // The domain's two-way split is preserved rather than flattened into one status, because the two
    // mean different things to a client: a request that is unusable as written cannot succeed on retry,
    // while a window this host cannot serve can, once the operator installs what is missing.
    // Arrange
    const badRequest = new FakeBrowserLogin(new BrowserControlError('bad_request', 'a duration is required'));
    const hostCannot = new FakeBrowserLogin(
      new BrowserControlError('launch_failed', 'x11vnc was not found on this host'),
    );

    // Act
    const refused = await dispatcherFor(badRequest).dispatch(post({ action: 'confirm' }));
    const unavailable = await dispatcherFor(hostCannot).dispatch(post({ action: 'start' }));
    const readFailed = await dispatcherFor(hostCannot).dispatch(request({ path: '/v1/browser/login', headers: human }));

    // Assert
    should(refused.status).equal(400);
    should(String(refused.body)).match(/a duration is required/);
    should(unavailable.status).equal(503);
    should(String(unavailable.body)).match(/x11vnc was not found/);
    // A READ refuses for the same reason a start does — the real `status` asks the profile store
    // whether it is primed — so the GET goes through the same mapping rather than its own.
    should(readFailed.status).equal(503);
  });

  it('should let an unexpected failure surface as the defect it is rather than as a refusal', async () => {
    // Arrange
    const dispatcher = dispatcherFor(new BrokenBrowserLogin());

    // Act
    const read = await dispatcher.dispatch(request({ path: '/v1/browser/login', headers: human }));
    const acted = await dispatcher.dispatch(post({ action: 'start' }));

    // Assert
    should(read.status).equal(500);
    should(acted.status).equal(500);
    // The dispatcher replaces an unexpected message with a fixed one, which matters here: the real
    // messages name the operator's profile path.
    should(String(read.body)).not.match(/operator/);
  });

  it('should keep the window out of reach of a warden-scoped token', async () => {
    // The status IS a credential — a live VNC port and password — and starting one puts a desktop on
    // the host. A token that may read fleet health must not be able to do either.
    // Arrange
    const window = new FakeBrowserLogin();
    const dispatcher = dispatcherFor(window);

    // Act
    const anonymous = await dispatcher.dispatch(request({ path: '/v1/browser/login' }));
    const wardenRead = await dispatcher.dispatch(request({ path: '/v1/browser/login', headers: warden }));

    // Assert
    should(anonymous.status).equal(401);
    should(wardenRead.status).equal(403);
    should(window.calls).deepEqual([]);
  });

  it('should tell a per-session browser caller what is missing instead of answering unknown_route', async () => {
    // `fy browser open` is a shipped command. A 404 is indistinguishable from version skew; a 501
    // naming what is genuinely absent — the composed per-session runtime and viewer host, not the
    // worker program or its transport — is something an operator can act on.
    // Arrange
    const dispatcher = dispatcherFor(new FakeBrowserLogin());

    // Act
    const read = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/browser', headers: human }));
    const acted = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s1/browser',
        headers: human,
        body: JSON.stringify({ action: 'start' }),
      }),
    );

    // Assert
    should(read.status).equal(501);
    should(acted.status).equal(501);
    should(String(acted.body)).match(/nothing composes them into the per-session runtime and viewer host/);
    should(String(acted.body)).not.match(/no browser worker program/);
  });
});

/**
 * The per-session browser, once a host IS behind the mount.
 *
 * These cases are about the TRANSPORT again, not the host: which path segment becomes a session id,
 * what each domain refusal becomes on the wire, and what a viewer may buy before it upgrades. The
 * host itself — capacity, the serialised action queue, viewer bookkeeping — is proved against
 * `BrowserSessionService`, and the launched Chrome against the runtime adapter.
 */

const PAGE = { id: 'p1', url: 'https://example.com/', title: 'Example Domain' };

const SNAPSHOT: BrowserPageSnapshot = {
  url: PAGE.url,
  title: PAGE.title,
  pages: [PAGE],
  activePageId: PAGE.id,
  pageState: 'ready',
  canGoBack: false,
  canGoForward: false,
};

const RUNNING: BrowserStatus = {
  ...SNAPSHOT,
  state: 'running',
  sessionId: 's1',
  viewport: { width: 1280, height: 800 },
  viewers: 0,
  persistentProfile: true,
  profileKind: 'shared',
  idleTimeoutSeconds: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  capacity: { running: 1, maximum: 3 },
};

/** A browser host this file fully controls: it records what the mount asked of it, and answers with
 *  either the projection a viewer parses or the domain's own refusal. */
class FakeBrowser implements BrowserMountedSubsystem {
  readonly calls: string[] = [];
  constructor(private readonly failure?: unknown) {}
  async status(sessionId: string): Promise<BrowserStatus> {
    this.calls.push(`status:${sessionId}`);
    if (this.failure !== undefined) throw this.failure;
    return { ...RUNNING, sessionId };
  }
  async act(sessionId: string, action: BrowserAction): Promise<BrowserActionResult> {
    this.calls.push(`act:${sessionId}:${action.action}`);
    if (this.failure !== undefined) throw this.failure;
    return { status: { ...RUNNING, sessionId }, result: { ...SNAPSHOT, actedPageId: PAGE.id } };
  }
  async attachViewer(): Promise<{ detach: () => void }> {
    throw new Error('the viewer attaches through the socket handler, not through this mount');
  }
  async dispatchHumanInput(): Promise<void> {
    throw new Error('human input arrives on the socket, not through this mount');
  }
  async closeAll(): Promise<void> {
    this.calls.push('close-all');
  }
  async stream(sessionId: string, downstream: SocketDownstream): Promise<SocketHandler> {
    this.calls.push(`stream:${sessionId}`);
    return {
      open: async () => {
        downstream.send(`open:${sessionId}`);
      },
      fromClient: () => undefined,
      close: () => undefined,
    };
  }
}

const REGISTRY = () => new SocketTicketRegistry({ now: () => 1_000 }, { ticket: () => `fy_ticket_${'b'.repeat(43)}` });

const served = (browser: FakeBrowser, tickets?: SocketTicketRegistry): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(browserLoginRoutes(new FakeBrowserLogin(), browser, tickets)), CREDENTIALS, GRANTED);

const act = (path: string, body: unknown) =>
  request({
    method: 'POST',
    path,
    headers: { ...human, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the mounted per-session browser', () => {
  it('should answer a read with the page projection its viewer parses', async () => {
    // Arrange
    const browser = new FakeBrowser();

    // Act
    const response = await served(browser).dispatch(request({ path: '/v1/sessions/s1/browser', headers: human }));

    // Assert — the reader parses this with the protocol schema, so the mount is held to it here.
    should(response.status).equal(200);
    should(BrowserStatusSchema.parse(JSON.parse(String(response.body)))).have.property('activePageId', 'p1');
    should(browser.calls).deepEqual(['status:s1']);
    // A live page list names tabs a later reader must not be shown from a cache.
    should(response.headers?.get('cache-control')).equal('no-store');
  });

  it('should carry an action to the host and answer with the result the host produced', async () => {
    // Arrange
    const browser = new FakeBrowser();

    // Act
    const response = await served(browser).dispatch(act('/v1/sessions/s1/browser', { action: 'open', url: PAGE.url }));

    // Assert
    should(response.status).equal(200);
    should(BrowserActionResultSchema.parse(JSON.parse(String(response.body)))).have.property('result');
    should(browser.calls).deepEqual(['act:s1:open']);
  });

  it('should refuse a session id the path cannot carry, before the host is asked', async () => {
    // A separator reaching a browser host would name a directory rather than a session, and the
    // router hands the segment over RAW — `URL.pathname` keeps its percent-encoding and nothing
    // decodes it — so the guard has to read the literal characters, which is what this drives.
    // Arrange
    const browser = new FakeBrowser();

    // Act
    const escaped = await served(browser).dispatch(request({ path: '/v1/sessions/a\\b/browser', headers: human }));

    // Assert
    should(escaped.status).equal(400);
    should(jsonBody(escaped)).have.property('code', 'bad_request');
    should(browser.calls).deepEqual([]);
  });

  it('should give every browser refusal the status a client can act on', async () => {
    // The domain's five codes mean five different things to a caller: a session that is not here, a
    // daemon already at capacity, a browser that is not running, a host that cannot launch one, and a
    // worker that answered badly. Flattening them would make all five look like the same outage.
    // Arrange
    const codes = ['not_found', 'capacity', 'not_running', 'launch_failed', 'upstream_failed'] as const;

    // Act
    const statuses = await Promise.all(
      codes.map(async code => {
        const refused = new FakeBrowser(new BrowserSessionError(code, `browser said ${code}`));
        const response = await served(refused).dispatch(request({ path: '/v1/sessions/s1/browser', headers: human }));
        return [response.status, (jsonBody(response) as { code?: string }).code];
      }),
    );

    // Assert
    should(statuses).deepEqual([
      [404, 'not_found'],
      [409, 'capacity'],
      [409, 'not_running'],
      [503, 'launch_failed'],
      [502, 'upstream_failed'],
    ]);
  });

  it('should let an unexpected host failure surface as the defect it is rather than as a refusal', async () => {
    // Arrange
    const broken = new FakeBrowser(new TypeError('the worker client is undefined'));

    // Act
    const read = await served(broken).dispatch(request({ path: '/v1/sessions/s1/browser', headers: human }));
    const acted = await served(broken).dispatch(act('/v1/sessions/s1/browser', { action: 'stop' }));

    // Assert
    should([read.status, acted.status]).deepEqual([500, 500]);
  });

  it('should sell a stream ticket that redeems only for this session browser socket', async () => {
    // The viewer's WebSocket can carry no device token, so the ticket is the credential — and it must
    // be worthless anywhere but this one session's stream path.
    // Arrange
    const browser = new FakeBrowser();
    const tickets = REGISTRY();

    // Act
    const sold = await served(browser, tickets).dispatch(act('/v1/sessions/s1/browser/stream/ticket', {}));
    const body = SocketTicketResponseSchema.parse(JSON.parse(String(sold.body)));

    // Assert
    should(sold.status).equal(201);
    should(body.ttlSeconds).equal(30);
    should(tickets.redeem(body.ticket, '/v1/sessions/s1/browser/stream')).have.property('tokenClass', 'admin');
    // The host was asked first: a ticket for a browser this daemon does not hold is a credential for
    // a socket that would refuse anyway.
    should(browser.calls).deepEqual(['status:s1']);
  });

  it('should refuse to mint a ticket for a session browser this daemon does not hold', async () => {
    // Arrange
    const absent = new FakeBrowser(new BrowserSessionError('not_found', 'the session does not exist'));

    // Act
    const sold = await served(absent, REGISTRY()).dispatch(act('/v1/sessions/s1/browser/stream/ticket', {}));

    // Assert
    should(sold.status).equal(404);
  });

  it('should refuse to mint a ticket for a caller whose credential it cannot see', async () => {
    // Unreachable through the dispatcher, which always resolves a credential for a scoped route.
    // Asserted directly because the alternative to knowing WHO asked is minting authority for nobody.
    // Arrange
    const counter = browserLoginRoutes(new FakeBrowserLogin(), new FakeBrowser(), REGISTRY()).find(
      route => route.path === '/v1/sessions/:sessionId/browser/stream/ticket',
    );

    // Act
    const refusal = await counter
      ?.handle({ request: act('/v1/sessions/s1/browser/stream/ticket', {}), params: new Map([['sessionId', 's1']]) })
      .then(() => undefined)
      .catch((error: unknown) => error as { status?: number });

    // Assert
    should(refusal).have.property('status', 401);
  });

  it('should offer no ticket counter at all when no broker was composed', async () => {
    // Arrange / Act
    const paths = browserLoginRoutes(new FakeBrowserLogin(), new FakeBrowser()).map(route => route.path);

    // Assert — a counter that could not mint anything would answer 500 where 404 is the truth.
    should(paths).not.containEql('/v1/sessions/:sessionId/browser/stream/ticket');
  });
});

/**
 * The session browser STREAM — a protocol switch rather than a response.
 *
 * Everything a viewer could be told with a status is settled BEFORE the socket exists, for the same
 * reason the terminal stream settles it: a socket that upgraded and then closed cannot distinguish
 * "no such session browser" from "the daemon broke".
 */
describe('the mounted session browser stream', () => {
  const sockets = (browser: FakeBrowser): ApiSocketDispatcher =>
    new ApiSocketDispatcher(new ApiRouter(browserSocketRoutes(browser)), CREDENTIALS, NO_TICKETS, GRANTED);

  /** A downstream that records, standing in for the socket the transport would supply. */
  const downstream = (): { readonly sent: string[]; readonly port: SocketDownstream } => {
    const sent: string[] = [];
    return {
      sent,
      port: {
        send: frame => sent.push(typeof frame === 'string' ? frame : new TextDecoder().decode(frame)),
        close: () => undefined,
        bufferedBytes: () => 0,
      },
    };
  };

  it('should attach a viewer to a session browser this daemon holds', async () => {
    // Arrange
    const browser = new FakeBrowser();
    const viewer = downstream();

    // Act
    const decision = await sockets(browser).upgrade(
      request({ path: '/v1/sessions/s1/browser/stream', headers: human }),
    );
    if (decision.outcome === 'accepted') await (await decision.attach(viewer.port)).open();

    // Assert — the host is asked for the session BEFORE the switch, and the same host then drives it.
    should(decision.outcome).equal('accepted');
    should(browser.calls).deepEqual(['status:s1', 'stream:s1']);
    should(viewer.sent).deepEqual(['open:s1']);
  });

  it('should refuse a stream for a session browser that is not there, before switching protocols', async () => {
    // Arrange
    const absent = new FakeBrowser(new BrowserSessionError('not_found', 'the session does not exist'));

    // Act
    const decision = await sockets(absent).upgrade(request({ path: '/v1/sessions/s1/browser/stream', headers: human }));

    // Assert
    should(decision.outcome).equal('refused');
    should(decision.outcome === 'refused' ? decision.response.status : 0).equal(404);
  });

  it('should refuse a session id the path cannot carry', async () => {
    // Arrange
    const browser = new FakeBrowser();

    // Act
    const decision = await sockets(browser).upgrade(
      request({ path: '/v1/sessions/a\\b/browser/stream', headers: human }),
    );

    // Assert
    should(decision.outcome === 'refused' ? decision.response.status : 0).equal(400);
    should(browser.calls).deepEqual([]);
  });
});
