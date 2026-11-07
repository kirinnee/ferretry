/**
 * THIS SESSION'S BROWSER PAGES, as the daemon lists them — for the browser surface list, for proving
 * `%browser:` references, and for bringing a page's tab into the person's view.
 *
 * One read of `GET /v1/sessions/:sessionId/browser` through the daemon's client, again on every
 * `browsers.page-changed` event of the session — or every {@link SESSION_BROWSER_POLL_MS} as the safety net. The
 * status lists every page that belongs to the session — the agent's and the person's, popups included — and nothing
 * of any other session's.
 *
 * NULL IS "NOT READ". A device without the `browser` grant, a daemon that cannot answer, or a page that
 * has not asked yet all read as null, and a reader of null proves nothing and lists nothing. An answer
 * for another session is a crossed response and is dropped rather than shown.
 *
 * The returned status keeps its identity while the pages a reader sees are unchanged, so a consumer
 * memoised on it — the transcript's reference surface above all — does not rebuild on every poll.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageChanged } from '../../../contract/index.ts';
import { fetchRemoteBrowserStatus, runRemoteBrowserAction } from '../../lib/remote-browser.ts';
import type { BrowserDaemon, BrowserSessionScope } from '../../lib/scope.ts';
import type { BrowserAction, BrowserPageSummary, BrowserStatus } from '../../lib/wire/browser.ts';

/** The safety-net re-read, for a page closed or moved without an event. */
export const SESSION_BROWSER_POLL_MS = 30_000;

/** Cancellable repeat, injectable so tests drive the poll instead of waiting. */
export type SessionBrowserScheduler = (callback: () => void, intervalMs: number) => () => void;

const defaultScheduler: SessionBrowserScheduler = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
};

export interface SessionBrowserDependencies {
  readonly pollMs?: number;
  /** The poll's timer; the browser's when absent. */
  readonly schedule?: SessionBrowserScheduler;
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
  scope: BrowserSessionScope,
  daemon: BrowserDaemon,
  dependencies?: SessionBrowserDependencies,
): SessionBrowser {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const pollMs = dependencies?.pollMs ?? SESSION_BROWSER_POLL_MS;
  const schedule = dependencies?.schedule ?? defaultScheduler;
  const epoch = useRef(0);

  const read = useCallback(
    (mine: number): void => {
      fetchRemoteBrowserStatus(daemon, scope)
        .then(next => {
          if (epoch.current === mine) setStatus(next);
        })
        .catch(() => {
          // Unread proves nothing: the list says it cannot see the pages, and no reference is proved.
        });
    },
    [daemon, scope],
  );

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setStatus(null);
    read(mine);
    const cancelPoll = schedule(() => read(mine), pollMs);
    const cancelEvents = daemon.client.subscribe(PageChanged, change => {
      if (change.ferret === scope.sessionId) read(mine);
    });
    return () => {
      cancelPoll();
      cancelEvents();
    };
  }, [read, daemon, scope.sessionId, pollMs, schedule]);

  const act = useCallback(
    async (action: BrowserAction): Promise<BrowserStatus | null> => {
      const mine = epoch.current;
      try {
        const result = await runRemoteBrowserAction(daemon, scope, action);
        if (epoch.current !== mine) return null;
        setStatus(result.status);
        return result.status;
      } catch {
        // The page closed under the click, or the daemon refused: the next read says which.
        read(mine);
        return null;
      }
    },
    [daemon, scope, read],
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
  return useMemo(() => ({ status: stable, activatePage, act }), [stable, activatePage, act]);
}
