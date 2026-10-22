/**
 * THIS SESSION'S BROWSER PAGES, as the daemon lists them — for the browser surface list, for proving
 * `%browser:` references, and for bringing a page's tab into the person's view.
 *
 * One read of `GET /v1/sessions/:id/browser`, again on every surface or browser event of the session's live
 * feed — or every {@link SESSION_BROWSER_POLL_MS} while there is none (`feed-aware-poll.ts`) — through the
 * daemon client (the store's pool, so direct and relay alike). The status lists every page that belongs
 * to the session — the agent's and the person's, popups included — and nothing of any other session's.
 *
 * NULL IS "NOT READ". A device without the `browser` grant, a daemon that cannot answer, or a page that
 * has not asked yet all read as null, and a reader of null proves nothing and lists nothing. An answer
 * for another session is a crossed response and is dropped rather than shown.
 *
 * The returned status keeps its identity while the pages a reader sees are unchanged, so a consumer
 * memoised on it — the transcript's reference surface above all — does not rebuild on every poll.
 */

import {
  type BrowserAction,
  BrowserActionResultSchema,
  type BrowserPageSummary,
  type BrowserStatus,
  BrowserStatusSchema,
  type IFyApiClient,
} from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { type FeedAwarePollEnvironment, type LiveFeedSignal, startFeedAwarePoll } from '../../lib/feed-aware-poll.ts';

/** How often the page list is re-read while no live feed is saying what changed. */
export const SESSION_BROWSER_POLL_MS = 10_000;

/** The safety-net re-read while the feed is live, for a page closed or moved without a journal entry. */
export const SESSION_BROWSER_LIVE_POLL_MS = 120_000;

/** A feed event that may have changed the session's pages: a surface or a browser one. */
export const movesBrowserPages = (event: { readonly type: string }): boolean =>
  event.type.startsWith('surface.') || event.type.startsWith('browser.');

export interface SessionBrowserDependencies {
  /** The daemon client for a connection — the store's pool in the app. */
  readonly client: (daemon: DaemonConnection) => Promise<Pick<IFyApiClient, 'request'>>;
  readonly pollMs?: number;
  readonly livePollMs?: number;
  /** The session's live feed: while it is live the list is re-read on its events, not on a timer. */
  readonly events?: LiveFeedSignal;
  /** The poll's timers and visibility; the browser's when absent. */
  readonly pollEnvironment?: FeedAwarePollEnvironment;
}

export interface SessionBrowser {
  /** The session's browser status, or null until one has been read. */
  readonly status: BrowserStatus | null;
  /** Points the person's view at this page — what opening its tab means. */
  readonly activatePage: (pageId: string) => void;
  /**
   * One person's toolbar action on the session's browser — a new page, a closed one. Answers the status
   * the daemon reports after it, or null when it was refused; a refusal is followed by a fresh read.
   */
  readonly act: (action: BrowserAction) => Promise<BrowserStatus | null>;
}

const NO_SESSION_BROWSER: SessionBrowser = Object.freeze({
  status: null,
  activatePage: () => undefined,
  act: async () => null,
});

/** The browser route of one session. */
export const sessionBrowserPath = (scope: DaemonSessionScope): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/browser`;

/** Every fact about a page that a list row or a proof reads — and nothing that merely ticks. */
const pageIdentity = (page: BrowserPageSummary): string =>
  [
    page.id,
    page.name ?? '',
    page.title,
    page.url,
    page.incognito === true ? 'i' : '',
    page.ownerSessionId ?? '',
    page.ownerName ?? '',
  ].join('\u0002');

/** The status's identity: its session, its state, the page in view and every page's own facts. */
export const sessionBrowserIdentity = (status: BrowserStatus | null): string =>
  status === null
    ? 'unread'
    : [
        status.sessionId,
        status.state,
        'activePageId' in status ? status.activePageId : '',
        ...status.pages.map(pageIdentity),
      ].join('\u0001');

/**
 * The page a key names in this status — its human name, or the browser's page id — or undefined when
 * the session holds no such page.
 */
export const browserPageForKey = (status: BrowserStatus | null, key: string): BrowserPageSummary | undefined =>
  status?.pages.find(page => page.id === key || page.name === key);

export function useSessionBrowser(
  scope: DaemonSessionScope,
  connection: DaemonConnection,
  dependencies?: SessionBrowserDependencies,
): SessionBrowser {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const client = dependencies?.client;
  const pollMs = dependencies?.pollMs ?? SESSION_BROWSER_POLL_MS;
  const livePollMs = dependencies?.livePollMs ?? SESSION_BROWSER_LIVE_POLL_MS;
  const events = dependencies?.events;
  const pollEnvironment = dependencies?.pollEnvironment;
  const epoch = useRef(0);

  const read = useCallback(
    (mine: number): void => {
      if (client === undefined) return;
      client(connection)
        .then(api => api.request(sessionBrowserPath(scope), BrowserStatusSchema))
        .then(next => {
          if (epoch.current === mine && next.sessionId === scope.sessionId) setStatus(next);
        })
        .catch(() => {
          // Unread proves nothing: the list says it cannot see the pages, and no reference is proved.
        });
    },
    [client, connection, scope],
  );

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setStatus(null);
    return startFeedAwarePoll({
      read: () => read(mine),
      everyMs: pollMs,
      liveEveryMs: livePollMs,
      relevant: movesBrowserPages,
      ...(events === undefined ? {} : { feed: events }),
      ...(pollEnvironment === undefined ? {} : { environment: pollEnvironment }),
    });
  }, [read, pollMs, livePollMs, events, pollEnvironment]);

  const act = useCallback(
    async (action: BrowserAction): Promise<BrowserStatus | null> => {
      if (client === undefined) return null;
      const mine = epoch.current;
      try {
        const api = await client(connection);
        const result = await api.request(sessionBrowserPath(scope), BrowserActionResultSchema, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action),
        });
        if (epoch.current !== mine || result.status.sessionId !== scope.sessionId) return null;
        setStatus(result.status);
        return result.status;
      } catch {
        // The page closed under the click, or the daemon refused: the next read says which.
        read(mine);
        return null;
      }
    },
    [client, connection, scope, read],
  );
  const activatePage = useCallback(
    (pageId: string): void => {
      void act({ action: 'activate-page', pageId });
    },
    [act],
  );

  const identity = sessionBrowserIdentity(status);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity is the stable key for status
  const stable = useMemo(() => status, [identity]);
  return useMemo(
    () => (client === undefined ? NO_SESSION_BROWSER : { status: stable, activatePage, act }),
    [client, stable, activatePage, act],
  );
}
