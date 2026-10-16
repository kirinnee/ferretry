/**
 * Two live facts the session page's workspace reads from outside React: the screen it is on, and the
 * terminals the daemon holds for this session.
 */

import type { TerminalListView } from '@ferretry/protocol';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { TerminalDeckDependencies } from '../../components/session-terminal-deck.tsx';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { type WorkspaceFormFactor, workspaceFormFactor } from './phone/phone-tab.ts';

const subscribeResize = (listener: () => void): (() => void) => {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
};
const readFormFactor = (): WorkspaceFormFactor => workspaceFormFactor(window.innerWidth, window.innerHeight);

/** Phone, tablet split or desktop, re-read when the window changes size. */
export function useWorkspaceFormFactor(): WorkspaceFormFactor {
  return useSyncExternalStore(subscribeResize, readFormFactor, readFormFactor);
}

/** How often the transcript's `%terminal:` proof re-reads the daemon's listing. */
export const SESSION_TERMINALS_POLL_MS = 10_000;

/**
 * This session's terminal listing, for proving `%terminal:` chips — or null until one has been read.
 *
 * The SAME listing the terminal deck reads, through the deck's own dependencies, so a chip proves
 * against exactly the shells a terminal tab can show. The returned object keeps its identity while the
 * set of terminal ids is unchanged: the reference surface is memoised on it, and a fresh object every
 * poll would re-parse every Markdown block in the transcript for nothing.
 */
export function useSessionTerminals(
  deck: TerminalDeckDependencies | undefined,
  connection: DaemonConnection,
  scope: DaemonSessionScope,
): TerminalListView | null {
  const [listing, setListing] = useState<TerminalListView | null>(null);
  useEffect(() => {
    setListing(null);
    if (deck === undefined) return;
    let live = true;
    const read = (): void => {
      deck
        .list(connection, scope)
        .then(next => {
          if (live) setListing(next);
        })
        .catch(() => {
          // An unread listing proves nothing either way, which is what null already says.
        });
    };
    read();
    const timer = setInterval(read, SESSION_TERMINALS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [deck, connection, scope]);
  const identity = listing === null ? null : `${listing.sessionId}:${listing.terminals.map(t => t.id).join(',')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity is the stable key for listing
  return useMemo(() => listing, [identity]);
}
