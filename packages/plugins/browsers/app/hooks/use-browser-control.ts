/**
 * WHO IS DRIVING A PAGE — the one seam the bar's "Ferret is typing here" chip and Take over / Hand back read.
 *
 * The daemon says which page an agent is acting on, and which ones a person holds (`docs/agent-tools.md`). This hook
 * reads that for one session and answers per page:
 *
 *   READ     `GET /v1/ferrets/:ferretId/surfaces/browser/control` when the panel opens, again on every
 *            `browsers.page-changed` event of the session (the agent driving included), and every
 *            {@link PAGE_POLL_MS} while there is no live feed or {@link PAGE_LIVE_POLL_MS} as the safety net while
 *            there is, never while the tab is hidden (`startFeedAwarePoll`). That read is what makes a takeover survive a reload: the daemon keeps it and the page asks.
 *   LAPSE    a driving marker carries `until` and is shown only while `now < until`; a timer re-renders the moment
 *            the next one lapses, because no event says so.
 *   CONTROL  Take over / Hand back post `{ action, key }` to the same route; its answer is the whole view and
 *            replaces it.
 *
 * EVERY REQUEST GOES THROUGH THE DAEMON'S CLIENT, so it rides whichever carrier reaches the daemon and never the
 * plain network. A view this device cannot read (no `browser` grant) stays unread: no marker, no control, because a
 * control the daemon would refuse is worse than none.
 */

import { type FeedAwarePollEnvironment, startFeedAwarePoll } from '@ferretry/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SurfaceControlRequestSchema } from '../../contract/index.ts';
import {
  askedFor,
  drivingAgentName,
  drivingFor,
  nextDrivingLapse,
  takeoverFor,
  withControlView,
} from '../lib/browser-control.ts';
import { PAGE_LIVE_POLL_MS, PAGE_POLL_MS, pageChangeFeed } from '../lib/page-feed.ts';
import type { BrowserDaemon, BrowserSessionScope } from '../lib/scope.ts';
import { type SurfaceControlView, SurfaceControlViewSchema } from '../../contract/wire/control.ts';

const BROWSER_CONTROL_ROUTES = {
  read: 'GET /v1/ferrets/:ferretId/surfaces/browser/control',
  act: 'POST /v1/ferrets/:ferretId/surfaces/browser/control',
} as const;

/** A one-shot timer, injectable so a suite drives the lapse without waiting for it. */
export type ControlTimer = (callback: () => void, delayMs: number) => () => void;

export interface BrowserControlDependencies {
  /** The cadence while no live feed says what changed. */
  readonly pollMs?: number;
  /** The safety-net cadence while the feed is live. */
  readonly livePollMs?: number;
  /** The poll's timers and the tab's visibility; the browser's when absent. */
  readonly pollEnvironment?: FeedAwarePollEnvironment;
  readonly now?: () => number;
  readonly timer?: ControlTimer;
}

export interface BrowserControl {
  readonly driverFor: (key: string) => { readonly name: string } | null;
  readonly askFor: (key: string) => { readonly agent: string; readonly message?: string } | null;
  readonly takenOver: (key: string) => boolean;
  readonly takeOver: (key: string) => void;
  readonly handBack: (key: string) => void;
  /** Clears a hand-over ask from this panel without taking the page over. */
  readonly dismissAsk: (key: string) => void;
  /** The last Take over / Hand back the daemon refused, said as a sentence; null when none. */
  readonly failure: string | null;
}

const defaultTimer: ControlTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

const failureOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export function useBrowserControl(
  scope: BrowserSessionScope,
  daemon: BrowserDaemon,
  dependencies?: BrowserControlDependencies,
): BrowserControl {
  const [view, setView] = useState<SurfaceControlView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [, setLapses] = useState(0);
  const pollMs = dependencies?.pollMs ?? PAGE_POLL_MS;
  const livePollMs = dependencies?.livePollMs ?? PAGE_LIVE_POLL_MS;
  const pollEnvironment = dependencies?.pollEnvironment;
  const now = dependencies?.now ?? Date.now;
  const timer = dependencies?.timer ?? defaultTimer;
  /** Bumped on every re-scope, so an answer for the previous session is dropped, not shown. */
  const epoch = useRef(0);

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setView(null);
    setFailure(null);
    setDismissed(new Set());
    // Returned, so the feed-aware poll skips a tick while this read is parked (behind a locked machine's unlock).
    const read = (): Promise<void> =>
      daemon.client
        .call(BROWSER_CONTROL_ROUTES.read, { params: { ferretId: scope.sessionId }, quiet: true })
        .then(answer => {
          const parsed = SurfaceControlViewSchema.parse(answer);
          if (epoch.current === mine) setView(current => withControlView(current, scope.sessionId, parsed));
        })
        .catch(() => {
          // Unread or refused (no grant) proves nothing, and stays unread: no marker, no control.
        });
    return startFeedAwarePoll({
      read,
      everyMs: pollMs,
      liveEveryMs: livePollMs,
      relevant: () => true,
      feed: pageChangeFeed(daemon.client, scope.sessionId),
      ...(pollEnvironment === undefined ? {} : { environment: pollEnvironment }),
    });
  }, [daemon, scope.sessionId, pollMs, livePollMs, pollEnvironment]);

  // Re-render when the next driving marker lapses, since nothing else will say so.
  const lapse = nextDrivingLapse(view, now());
  useEffect(() => {
    if (lapse === undefined) return;
    return timer(() => setLapses(count => count + 1), Math.max(0, lapse - now()) + 1);
  }, [lapse, timer, now]);

  const control = useCallback(
    (action: 'takeover' | 'handback', key: string): void => {
      const mine = epoch.current;
      setFailure(null);
      daemon.client
        .call(BROWSER_CONTROL_ROUTES.act, {
          params: { ferretId: scope.sessionId },
          body: SurfaceControlRequestSchema.parse({ action, key }),
        })
        .then(answer => {
          const parsed = SurfaceControlViewSchema.parse(answer);
          if (epoch.current === mine) setView(current => withControlView(current, scope.sessionId, parsed));
        })
        .catch((reason: unknown) => {
          if (epoch.current === mine)
            setFailure(`Could not ${action === 'takeover' ? 'take over' : 'hand back'} ${key}: ${failureOf(reason)}`);
        });
    },
    [daemon, scope.sessionId],
  );

  const at = now();
  return {
    driverFor: key => {
      const driving = drivingFor(view, key, at);
      return driving === undefined ? null : { name: drivingAgentName(driving) };
    },
    askFor: key => {
      const asked = askedFor(view, key);
      if (asked === undefined || dismissed.has(asked.id)) return null;
      return {
        agent: asked.agentName ?? 'The agent',
        ...(asked.message === undefined ? {} : { message: asked.message }),
      };
    },
    takenOver: key => takeoverFor(view, key) !== undefined,
    takeOver: key => control('takeover', key),
    handBack: key => control('handback', key),
    dismissAsk: key => {
      const asked = askedFor(view, key);
      if (asked !== undefined) setDismissed(current => new Set([...current, asked.id]));
    },
    failure,
  };
}
