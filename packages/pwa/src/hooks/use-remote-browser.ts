/**
 * Remote browser lifecycle state for exactly one (daemon, session) pair.
 *
 * kteam polled a module-global browser status keyed by session id alone. That
 * is a correctness bug here, not a performance detail: a PWA page can switch
 * daemons while keeping the same session id, and the previous daemon's Chrome
 * would then be shown — and driven — under the new daemon's name.
 *
 * So the liveness key is the SCOPE PLUS THE CONNECTION — `(daemonId,
 * sessionId)` is not the whole of it. A daemon id is durable across a re-pair,
 * which is precisely when the base URL or the device token rotates, so an
 * id-only key would leave a rotation invisible and let the old credential's
 * late answer land here. Any change to either clears the snapshot synchronously
 * and invalidates every request already in flight.
 */

import type { BrowserAction, BrowserActionResult, BrowserStatus } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type DaemonConnection, sameDaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { fetchRemoteBrowserStatus, runRemoteBrowserAction } from '../lib/remote-browser.ts';

export const REMOTE_BROWSER_POLL_MS = 2_500;

export interface RemoteBrowserTransport {
  readonly readStatus: (daemon: DaemonConnection, scope: DaemonSessionScope) => Promise<BrowserStatus>;
  readonly runAction: (
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    action: BrowserAction,
  ) => Promise<BrowserActionResult>;
}

const defaultTransport: RemoteBrowserTransport = {
  readStatus: (daemon, scope) => fetchRemoteBrowserStatus(daemon, scope),
  runAction: (daemon, scope, action) => runRemoteBrowserAction(daemon, scope, action),
};

/** Cancellable repeat, injectable so tests drive the poll instead of waiting. */
export type RemoteBrowserScheduler = (callback: () => void, intervalMs: number) => () => void;

const defaultScheduler: RemoteBrowserScheduler = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
};

export interface UseRemoteBrowserOptions {
  /**
   * The paired daemon and its session scope. Both are effect dependencies, so a
   * caller that rebuilds an equivalent object every render must memoize them —
   * otherwise the poll re-arms on each frame.
   */
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** A hidden pane detaches; the daemon-side browser deliberately survives. */
  readonly isActive?: boolean;
  readonly pollIntervalMs?: number;
  readonly transport?: RemoteBrowserTransport;
  readonly schedule?: RemoteBrowserScheduler;
}

export interface RemoteBrowserModel {
  readonly status: BrowserStatus | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly runAction: (action: BrowserAction) => void;
  readonly refresh: () => void;
  readonly reportError: (message: string) => void;
  readonly clearError: () => void;
}

const failureMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useRemoteBrowser({
  daemon,
  scope,
  isActive = true,
  pollIntervalMs = REMOTE_BROWSER_POLL_MS,
  transport = defaultTransport,
  schedule = defaultScheduler,
}: UseRemoteBrowserOptions): RemoteBrowserModel {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generationRef = useRef(0);
  const mutationsRef = useRef(0);
  const pairingRef = useRef<{ readonly connection: DaemonConnection; readonly scope: DaemonSessionScope } | null>(null);
  const scopeEpochRef = useRef(0);

  // The liveness identity is the CONNECTION plus the scope, not `(daemonId,
  // sessionId)`. A re-pair keeps the daemon id and rotates the base URL and/or
  // the device token, so a key built from ids alone would let the previous
  // pairing's answer commit here as though this pairing had produced it.
  const previousPairing = pairingRef.current;
  const rescoped =
    previousPairing === null ||
    previousPairing.scope.daemonId !== scope.daemonId ||
    previousPairing.scope.sessionId !== scope.sessionId ||
    !sameDaemonConnection(previousPairing.connection, daemon);

  // Applied during render: a re-scoped or re-paired pane must never paint the
  // previous connection's lifecycle state, not even for the frame before its
  // first response.
  if (rescoped) {
    pairingRef.current = { connection: daemon, scope };
    scopeEpochRef.current += 1;
    generationRef.current += 1;
    mutationsRef.current = 0;
    if (status !== null) setStatus(null);
    if (error !== null) setError(null);
    if (busy) setBusy(false);
  }

  const commit = useCallback((generation: number, next: BrowserStatus): void => {
    if (generation !== generationRef.current) return;
    setStatus(next);
    if (next.state === 'error') setError(next.error);
  }, []);

  const fail = useCallback((generation: number, caught: unknown): void => {
    if (generation === generationRef.current) setError(failureMessage(caught));
  }, []);

  const refresh = useCallback(() => {
    // A mutation result is the authoritative newer snapshot. Polling resumes
    // once it settles rather than racing a pre-mutation read against it.
    if (mutationsRef.current > 0) return;
    const generation = ++generationRef.current;
    void transport
      .readStatus(daemon, scope)
      .then(next => commit(generation, next))
      .catch((caught: unknown) => fail(generation, caught));
  }, [commit, daemon, fail, scope, transport]);

  const runAction = useCallback(
    (action: BrowserAction) => {
      const generation = ++generationRef.current;
      // The mutation counter is reset to 0 on every re-scope AND every re-pair,
      // and thereafter belongs to the new pairing. An old connection's late
      // finally must not settle that pairing's accounting — it would decrement
      // a counter it never incremented and could clear busy while a new
      // action is in flight. Capturing the epoch at launch makes the finalizer
      // safe without weakening the generation fence on commit/fail above.
      const scopeEpochAtLaunch = scopeEpochRef.current;
      mutationsRef.current += 1;
      setBusy(true);
      setError(null);
      void transport
        .runAction(daemon, scope, action)
        .then(result => commit(generation, result.status))
        .catch((caught: unknown) => fail(generation, caught))
        .finally(() => {
          if (scopeEpochAtLaunch !== scopeEpochRef.current) return;
          mutationsRef.current = Math.max(0, mutationsRef.current - 1);
          if (mutationsRef.current === 0) setBusy(false);
        });
    },
    [commit, daemon, fail, scope, transport],
  );

  useEffect(() => {
    if (!isActive) return;
    refresh();
    const cancel = schedule(() => refresh(), pollIntervalMs);
    return () => {
      cancel();
      // A hidden or unmounted pane must not publish a response it sampled while
      // it was still attached.
      generationRef.current += 1;
    };
  }, [isActive, pollIntervalMs, refresh, schedule]);

  const reportError = useCallback((message: string) => setError(message), []);
  const clearError = useCallback(() => setError(null), []);

  return { status, error, busy, runAction, refresh, reportError, clearError };
}
