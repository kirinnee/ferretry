import { BrowserCommandError, type BrowserCommand, type BrowserRequest } from './types.ts';

export const BROWSER_LOGIN_PATH = '/v1/browser/login';

export const sessionBrowserPath = (sessionId: string): string =>
  `/v1/sessions/${encodeURIComponent(sessionId)}/browser`;

/**
 * Translate a command into the daemon call that performs it.
 *
 * The login window is built first and without a session: it is daemon-global, about the one shared
 * profile rather than about any session, so demanding a session id for it would misdescribe what the
 * route targets.
 */
export function browserRequest(command: BrowserCommand, selfSessionId?: string): BrowserRequest {
  if (command.command === 'login') return loginRequest(command);

  const sessionId = command.session?.trim() || selfSessionId?.trim();
  if (!sessionId) {
    throw new BrowserCommandError('no session id; run inside a session or pass --session <id>');
  }
  const path = sessionBrowserPath(sessionId);
  const post = (body: Record<string, unknown>): BrowserRequest => ({ method: 'POST', path, body });

  switch (command.command) {
    case 'status':
      return { method: 'GET', path };
    case 'start':
      return post({ action: 'start' });
    case 'open':
      return post({ action: 'open', ...(command.url ? { url: command.url } : {}) });
    case 'new-page':
      return post({ action: 'new-page', ...(command.url ? { url: command.url } : {}) });
    case 'activate-page':
      return post({ action: 'activate-page', pageId: command.pageId });
    case 'close-page':
      return post({ action: 'close-page', pageId: command.pageId });
    case 'stop':
      return post({ action: 'stop' });
    case 'navigate':
      return post({ action: 'navigate', url: command.url });
    case 'click':
      return post({ action: 'click', selector: command.selector });
    case 'type':
      return post({ action: 'type', selector: command.selector, text: command.text });
    case 'read':
      return post({ action: 'read', ...(command.selector ? { selector: command.selector } : {}) });
    case 'screenshot':
      return post({ action: 'screenshot' });
    case 'back':
      return post({ action: 'back' });
    case 'forward':
      return post({ action: 'forward' });
    case 'reload':
      return post({ action: 'reload' });
    case 'resize':
      return post({ action: 'resize', width: command.width, height: command.height });
  }
}

function loginRequest(command: Extract<BrowserCommand, { command: 'login' }>): BrowserRequest {
  switch (command.action) {
    case 'status':
      return { method: 'GET', path: BROWSER_LOGIN_PATH };
    case 'start':
      return {
        method: 'POST',
        path: BROWSER_LOGIN_PATH,
        body: { action: 'start', ...(command.minutes === undefined ? {} : { minutes: command.minutes }) },
      };
    case 'stop':
      return {
        method: 'POST',
        path: BROWSER_LOGIN_PATH,
        body: { action: 'stop', ...(command.primed === undefined ? {} : { primed: command.primed }) },
      };
    case 'confirm':
      return { method: 'POST', path: BROWSER_LOGIN_PATH, body: { action: 'confirm' } };
  }
}
