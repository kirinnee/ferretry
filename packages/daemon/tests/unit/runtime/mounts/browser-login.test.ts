import { describe, it } from 'bun:test';
import { BrowserLoginStatusSchema } from '@ferretry/protocol';
import should from 'should';
import { BrowserControlError } from '../../../../src/lib/browser/control/index.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { browserLoginRoutes } from '../../../../src/lib/runtime/mounts/browser-login.ts';
import { request } from '../../api/support.ts';
import { BrokenBrowserLogin, CREDENTIALS, FakeBrowserLogin, human } from './support.ts';

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
  new ApiDispatcher(new ApiRouter(browserLoginRoutes(window)), CREDENTIALS);

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
    // naming the absent worker program and viewer host is something an operator can act on.
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
    should(String(acted.body)).match(/no browser worker program/);
  });
});
