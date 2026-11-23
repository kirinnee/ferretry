/**
 * WHICH DAEMON AND WHICH SESSION a browser surface speaks for.
 *
 * The shell builds this half once per daemon and hands it that daemon's own guarded client (§9.6), so a
 * {@link BrowserDaemon} is the client plus the id of the daemon it reaches. Two of them are the same daemon only
 * when they carry the same client: a re-paired daemon is a NEW client, and nothing that held the old one may report
 * into the new pairing (the liveness rule `use-remote-browser.ts` and the pane apply).
 */

import type { PluginClient, PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';

/** The client a Browsers surface rides: calls, events and the guarded display socket. */
export interface BrowsersClient extends PluginClient {
  socket(key: string, params: Readonly<Record<string, string>>, listeners: PluginSocketListeners): PluginSocket;
}

/** True when the shell's client can open a socket (a client of another build cannot stream a page). */
export const canOpenSocket = (client: PluginClient): client is BrowsersClient =>
  typeof (client as Partial<BrowsersClient>).socket === 'function';

export interface BrowserDaemon {
  readonly daemonId: string;
  readonly client: PluginClient;
}

export const sameBrowserDaemon = (left: BrowserDaemon, right: BrowserDaemon): boolean =>
  left.daemonId === right.daemonId && left.client === right.client;

export interface BrowserSessionScope {
  readonly daemonId: string;
  readonly sessionId: string;
  /**
   * Where the ONE screen this scope speaks for keeps the id its display stream was given (`BROWSER_VIEWER_QUERY`): while a
   * stream is up its status reads and acts carry that id, so the page it shows is its own. Absent, or empty, the scope is
   * the session's own view.
   */
  readonly viewer?: BrowserViewerSlot;
}

/**
 * The id the DAEMON gave one screen's display stream, kept for the calls that name that screen. The stream sets it when
 * the daemon says who it is and clears it when the stream ends; nothing else ever writes it, and the client never makes
 * one up.
 */
export interface BrowserViewerSlot {
  current(): string | undefined;
  set(id: string | undefined): void;
}

export const browserViewerSlot = (): BrowserViewerSlot => {
  let held: string | undefined;
  return {
    current: () => held,
    set: id => {
      held = id;
    },
  };
};

const requireSessionId = (value: string): string => {
  if (value.trim() === '') throw new Error('sessionId must not be empty');
  return value;
};

/** The required `(daemonId, sessionId)` identity for UI state. */
export const browserSessionScope = (
  daemon: Pick<BrowserDaemon, 'daemonId'>,
  sessionId: string,
  viewer?: BrowserViewerSlot,
): BrowserSessionScope => ({
  daemonId: daemon.daemonId,
  sessionId: requireSessionId(sessionId),
  ...(viewer === undefined ? {} : { viewer }),
});

/** A collision-safe key for in-memory session state. */
export const browserSessionKey = (scope: BrowserSessionScope): string =>
  JSON.stringify([scope.daemonId, scope.sessionId]);
