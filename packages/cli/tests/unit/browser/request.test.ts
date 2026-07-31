import { describe, it } from 'bun:test';
import should from 'should';
import { BROWSER_LOGIN_PATH, browserRequest, sessionBrowserPath } from '../../../src/lib/browser/request';
import { type BrowserCommand, BrowserCommandError } from '../../../src/lib/browser/types';

type SessionCommand = Exclude<BrowserCommand, { command: 'login' }>;

const SESSION_PATH = '/v1/sessions/sess-1/browser';

describe('session targeting', () => {
  it('should address the session named on the command', () => {
    // Act
    const actual = browserRequest({ command: 'status', session: 'sess-1' }, 'other');

    // Assert
    should(actual).deepEqual({ method: 'GET', path: SESSION_PATH });
  });

  it('should fall back to the session the CLI is running inside', () => {
    // Act
    const actual = browserRequest({ command: 'status' }, 'sess-1');

    // Assert
    should(actual.path).equal(SESSION_PATH);
  });

  it('should refuse when neither a flag nor an enclosing session names a target', () => {
    // Act + Assert
    should(() => browserRequest({ command: 'status' })).throw(BrowserCommandError);
    should(() => browserRequest({ command: 'status', session: '   ' }, '  ')).throw(/pass --session/u);
  });

  it('should percent-encode an id so a crafted id cannot escape its route', () => {
    // Act
    const actual = sessionBrowserPath('a/../admin');

    // Assert
    should(actual).equal('/v1/sessions/a%2F..%2Fadmin/browser');
  });
});

describe('session actions', () => {
  const cases: Array<[string, SessionCommand, unknown]> = [
    ['start', { command: 'start' }, { action: 'start' }],
    ['stop', { command: 'stop' }, { action: 'stop' }],
    ['back', { command: 'back' }, { action: 'back' }],
    ['forward', { command: 'forward' }, { action: 'forward' }],
    ['reload', { command: 'reload' }, { action: 'reload' }],
    ['screenshot', { command: 'screenshot', output: 'shot.png' }, { action: 'screenshot' }],
    ['open with a url', { command: 'open', url: 'https://a.test' }, { action: 'open', url: 'https://a.test' }],
    ['open without a url', { command: 'open' }, { action: 'open' }],
    ['new-page without a url', { command: 'new-page' }, { action: 'new-page' }],
    [
      'new-page with a url',
      { command: 'new-page', url: 'https://a.test' },
      { action: 'new-page', url: 'https://a.test' },
    ],
    ['activate-page', { command: 'activate-page', pageId: 'p1' }, { action: 'activate-page', pageId: 'p1' }],
    ['close-page', { command: 'close-page', pageId: 'p1' }, { action: 'close-page', pageId: 'p1' }],
    ['navigate', { command: 'navigate', url: 'https://a.test' }, { action: 'navigate', url: 'https://a.test' }],
    ['click', { command: 'click', selector: '#go' }, { action: 'click', selector: '#go' }],
    ['type', { command: 'type', selector: '#q', text: 'hi' }, { action: 'type', selector: '#q', text: 'hi' }],
    ['read of the body', { command: 'read' }, { action: 'read' }],
    ['read of a selector', { command: 'read', selector: 'main' }, { action: 'read', selector: 'main' }],
    ['resize', { command: 'resize', width: 800, height: 600 }, { action: 'resize', width: 800, height: 600 }],
  ];

  for (const [name, command, body] of cases) {
    it(`should POST the ${name} action`, () => {
      // Act
      const actual = browserRequest({ ...command, session: 'sess-1' });

      // Assert
      should(actual).deepEqual({ method: 'POST', path: SESSION_PATH, body });
    });
  }

  it('should GET the status rather than POST an action', () => {
    // Act
    const actual = browserRequest({ command: 'status', session: 'sess-1' });

    // Assert
    should(actual.method).equal('GET');
    should(actual.body).be.undefined();
  });
});

describe('the login window', () => {
  it('should be daemon-global, needing no session id at all', () => {
    // Act
    const actual = browserRequest({ command: 'login', action: 'status' });

    // Assert
    should(actual).deepEqual({ method: 'GET', path: BROWSER_LOGIN_PATH });
  });

  it('should carry a duration only when one was asked for', () => {
    // Act + Assert
    should(browserRequest({ command: 'login', action: 'start', minutes: 20 }).body).deepEqual({
      action: 'start',
      minutes: 20,
    });
    should(browserRequest({ command: 'login', action: 'start' }).body).deepEqual({ action: 'start' });
  });

  it('should carry the primed flag only when it was asked for', () => {
    // Act + Assert
    should(browserRequest({ command: 'login', action: 'stop', primed: true }).body).deepEqual({
      action: 'stop',
      primed: true,
    });
    should(browserRequest({ command: 'login', action: 'stop' }).body).deepEqual({ action: 'stop' });
  });

  it('should post a confirmation', () => {
    // Act
    const actual = browserRequest({ command: 'login', action: 'confirm' });

    // Assert
    should(actual).deepEqual({ method: 'POST', path: BROWSER_LOGIN_PATH, body: { action: 'confirm' } });
  });
});
