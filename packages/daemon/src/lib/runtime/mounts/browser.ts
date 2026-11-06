import type { AuditedRouteRule, AuditedSocketRule } from '../../audit/routes.ts';
import type { BrowserLoginLifecycle } from '../../browser/control/index.ts';
import type { ModuleContribution } from '../modules.ts';
import { type BrowserMountedSubsystem, browserLoginRoutes, browserSocketRoutes } from './browser-login.ts';
import { type BrowserProxySubsystem, browserProxyRoutes } from './browser-proxy.ts';

/**
 * The security log's rules for the browser surface. Opening the human sign-in window and taking control of a session's
 * browser are recorded by session or by the window; a proxy test is kept by name: only whether it reached, how long it
 * took and the error class — never an address, a header or a credential.
 */
const BROWSER_AUDIT_RULES: readonly AuditedRouteRule[] = [
  { method: 'POST', path: '/v1/browser/login', event: 'browser.opened', detail: { action: 'sign-in-window' } },
  // A proxy test makes this machine dial a proxy with the stored credentials, so it is kept by name: only whether
  // it reached, how long it took and the error class — never an address, a header or a credential. A refused
  // caller (an agent) reaches the handler and is recorded as refused.
  {
    method: 'POST',
    path: '/v1/browser/proxy/test',
    event: 'browser.proxy-tested',
    fixedSubject: 'browser-proxy',
    responseSettings: [],
    responseNames: 'errorClass',
  },
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/browser',
    event: 'browser.opened',
    subject: 'sessionId',
    detail: { action: 'control' },
  },
];

/** The browser stream socket: opening it is recorded on the session. */
const BROWSER_AUDIT_SOCKETS: readonly AuditedSocketRule[] = [
  { path: '/v1/sessions/:sessionId/browser/stream', event: 'browser.opened', subject: 'sessionId' },
];

/** What the browser module serves: the human sign-in window, the agent browser's host and the machine-wide proxy state. */
export interface BrowserSubsystems {
  readonly browserLogin: BrowserLoginLifecycle;
  readonly browser: BrowserMountedSubsystem;
  readonly browserProxy: BrowserProxySubsystem;
}

/**
 * What the browser module adds to the daemon: the login window and per-session browser routes, the proxy test and state
 * routes, the browser stream socket, and their audit rules. It claims no protocol feature.
 *
 * The login window is a fixed literal under `/v1/browser`, which no other subsystem uses, so it can neither shadow nor
 * be shadowed. Its per-session refusal is a deeper pattern ending in the literal `browser`, which distinguishes it from
 * every other `/v1/sessions/:id/...` route.
 */
export function browserContribution(subsystems: BrowserSubsystems): ModuleContribution {
  return {
    routes: [
      ...browserLoginRoutes(subsystems.browserLogin, subsystems.browser),
      ...browserProxyRoutes(subsystems.browserProxy),
    ],
    sockets: browserSocketRoutes(subsystems.browser),
    audit: { routes: BROWSER_AUDIT_RULES, sockets: BROWSER_AUDIT_SOCKETS },
  };
}
