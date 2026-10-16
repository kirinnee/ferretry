/**
 * WHO IS DRIVING A WORKSPACE TAB — the one seam the AGENT marker and Take over / Hand back read.
 *
 * The daemon says which terminal and which browser page an agent is acting on, and which ones a person
 * holds (`docs/agent-tools.md`). This hook reads that for one session and answers per workspace tab:
 *
 *   READ     `GET /v1/sessions/:id/surfaces/{terminals,browser}/control` when the page opens and then
 *            every {@link SURFACE_CONTROL_POLL_MS}. That read is what makes a takeover survive a reload:
 *            the daemon journals it and replays the journal, so the page asks and is told.
 *   LIVE     `surface.*` events from the session's own feed, folded in as they arrive, when the host
 *            has a feed to hand over. Without one the poll still gets there, only later.
 *   LAPSE    a driving marker carries `until` and is shown only while `now < until`; a timer re-renders
 *            the moment the next one lapses, because no event says so.
 *   CONTROL  Take over / Hand back post `{ action, key }` to the same route; its answer is that kind's
 *            whole view and replaces it.
 *
 * EVERY REQUEST GOES THROUGH THE DAEMON CLIENT, the store's pool, so it rides whichever carrier
 * reaches the daemon — direct or the relay — and never the plain network.
 *
 * A kind this device cannot read (no `terminal` or `browser` grant) stays unread: no marker, no
 * control, because a control the daemon would refuse is worse than none.
 */

import type { FyEvent, IFyApiClient, SurfaceKind } from '@ferretry/protocol';
import { SurfaceControlViewSchema } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import {
  activeSurfaceDriving,
  applySurfaceEvent,
  drivingAgentName,
  isSurfaceControlEvent,
  nextDrivingLapse,
  type SurfaceControlState,
  surfaceDrivingFor,
  surfaceTakeoverFor,
  UNREAD_SURFACE_CONTROL,
  withSurfaceControlView,
} from '../../lib/surface-control.ts';
import type { WorkspaceTabId } from '../../lib/workspace-layout.ts';
import { parseSidePaneInstanceTabId, sidePaneInstanceTabId } from '../../shell/side-pane-tab-model.ts';
import type { AgentControlDriver } from './agent-control-marker.tsx';

export interface SurfaceDriving {
  /** Tabs an agent is driving right now: the strip badges these AGENT. */
  readonly drivenTabIds: ReadonlySet<WorkspaceTabId>;
  readonly driverFor: (tabId: WorkspaceTabId) => AgentControlDriver | null;
  readonly takenOver: (tabId: WorkspaceTabId) => boolean;
  readonly takeOver: (tabId: WorkspaceTabId) => void;
  readonly handBack: (tabId: WorkspaceTabId) => void;
  /** The last Take over / Hand back the daemon refused, said as a sentence; null when none. */
  readonly failure: string | null;
}

/** Nobody drives anything: the answer for a host with no daemon client to ask. */
export const NO_SURFACE_DRIVING: SurfaceDriving = Object.freeze({
  drivenTabIds: new Set<WorkspaceTabId>(),
  driverFor: () => null,
  takenOver: () => false,
  takeOver: () => undefined,
  handBack: () => undefined,
  failure: null,
});

/** How often the control views are re-read when no event has said anything. */
export const SURFACE_CONTROL_POLL_MS = 10_000;

/** A session's live journal, as the page's host already subscribes to it. */
export interface SurfaceEventFeed {
  readonly subscribe: (listener: (event: FyEvent) => void) => () => void;
}

/** A one-shot timer, injectable so a suite drives the lapse without waiting for it. */
export type SurfaceTimer = (callback: () => void, delayMs: number) => () => void;

export interface SurfaceDrivingDependencies {
  /** The daemon client for a connection — the store's pool in the app. */
  readonly client: (daemon: DaemonConnection) => Promise<Pick<IFyApiClient, 'request'>>;
  readonly events?: SurfaceEventFeed;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly timer?: SurfaceTimer;
}

const SURFACE_KINDS: readonly SurfaceKind[] = ['terminal', 'browser'];

/** The control route of one kind: `terminals` is plural on the wire, `browser` is not. Two literal paths, so
 *  the route-agreement gate reads each one against the route the daemon serves. */
export const surfaceControlPath = (scope: DaemonSessionScope, kind: SurfaceKind): string =>
  kind === 'terminal'
    ? `/v1/sessions/${encodeURIComponent(scope.sessionId)}/surfaces/terminals/control`
    : `/v1/sessions/${encodeURIComponent(scope.sessionId)}/surfaces/browser/control`;

const defaultTimer: SurfaceTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/** The surface a tab shows — a terminal or a browser page — or null for any other tab. */
const surfaceOf = (tabId: WorkspaceTabId): { readonly kind: SurfaceKind; readonly key: string } | null => {
  const parsed = parseSidePaneInstanceTabId(tabId);
  if (parsed === null || parsed.kind === 'file') return null;
  return { kind: parsed.kind, key: parsed.key };
};

const failureOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * The session's control facts, live. Without dependencies — a host with no daemon client — nobody
 * drives anything and both intents do nothing, which is {@link NO_SURFACE_DRIVING}.
 */
export function useSurfaceDriving(
  scope: DaemonSessionScope,
  connection: DaemonConnection,
  dependencies?: SurfaceDrivingDependencies,
): SurfaceDriving {
  const [state, setState] = useState<SurfaceControlState>(UNREAD_SURFACE_CONTROL);
  const [failure, setFailure] = useState<string | null>(null);
  const [, setLapses] = useState(0);
  const client = dependencies?.client;
  const events = dependencies?.events;
  const pollMs = dependencies?.pollMs ?? SURFACE_CONTROL_POLL_MS;
  const now = dependencies?.now ?? Date.now;
  const timer = dependencies?.timer ?? defaultTimer;
  /** Bumped on every re-scope, so an answer for the previous session is dropped, not shown. */
  const epoch = useRef(0);

  // Read both kinds now and on every poll; reset the moment the scope changes.
  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setState(UNREAD_SURFACE_CONTROL);
    setFailure(null);
    if (client === undefined) return;
    const read = (): void => {
      for (const kind of SURFACE_KINDS)
        client(connection)
          .then(api => api.request(surfaceControlPath(scope, kind), SurfaceControlViewSchema))
          .then(view => {
            if (epoch.current === mine)
              setState(current => withSurfaceControlView(current, scope.sessionId, kind, view));
          })
          .catch(() => {
            // Unread or refused (no grant) proves nothing, and stays unread: no marker, no control.
          });
    };
    read();
    const poll = setInterval(read, pollMs);
    return () => clearInterval(poll);
  }, [client, connection, scope, pollMs]);

  // Fold the session's own control events in as they arrive.
  useEffect(() => {
    if (events === undefined || client === undefined) return;
    return events.subscribe(event => {
      if (isSurfaceControlEvent(event)) setState(current => applySurfaceEvent(current, scope.sessionId, event));
    });
  }, [events, client, scope]);

  // Re-render when the next driving marker lapses, since nothing else will say so.
  const lapse = nextDrivingLapse(state, now());
  useEffect(() => {
    if (lapse === undefined) return;
    return timer(() => setLapses(count => count + 1), Math.max(0, lapse - now()) + 1);
  }, [lapse, timer, now]);

  const control = useCallback(
    (action: 'takeover' | 'handback', tabId: WorkspaceTabId): void => {
      const surface = surfaceOf(tabId);
      if (client === undefined || surface === null) return;
      const mine = epoch.current;
      setFailure(null);
      client(connection)
        .then(api =>
          api.request(surfaceControlPath(scope, surface.kind), SurfaceControlViewSchema, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, key: surface.key }),
          }),
        )
        .then(view => {
          if (epoch.current === mine)
            setState(current => withSurfaceControlView(current, scope.sessionId, surface.kind, view));
        })
        .catch((reason: unknown) => {
          if (epoch.current === mine)
            setFailure(
              `Could not ${action === 'takeover' ? 'take over' : 'hand back'} ${surface.key}: ${failureOf(reason)}`,
            );
        });
    },
    [client, connection, scope],
  );

  const at = now();
  const driven = activeSurfaceDriving(state, at);
  const drivenKey = driven.map(driving => `${driving.surface}:${driving.id}:${driving.name ?? ''}`).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: drivenKey is the stable identity of `driven`
  const drivenTabIds = useMemo(
    () =>
      new Set(
        driven.flatMap(driving => [
          sidePaneInstanceTabId(driving.surface, driving.id),
          ...(driving.name === undefined ? [] : [sidePaneInstanceTabId(driving.surface, driving.name)]),
        ]),
      ),
    [drivenKey],
  );

  if (client === undefined) return NO_SURFACE_DRIVING;
  return {
    drivenTabIds,
    driverFor: tabId => {
      const surface = surfaceOf(tabId);
      const driving = surface === null ? undefined : surfaceDrivingFor(state, surface.kind, surface.key, at);
      return driving === undefined ? null : { name: drivingAgentName(driving) };
    },
    takenOver: tabId => {
      const surface = surfaceOf(tabId);
      return surface !== null && surfaceTakeoverFor(state, surface.kind, surface.key) !== undefined;
    },
    takeOver: tabId => control('takeover', tabId),
    handBack: tabId => control('handback', tabId),
    failure,
  };
}
