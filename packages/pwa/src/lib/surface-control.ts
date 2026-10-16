/**
 * WHO IS DRIVING A TERMINAL OR A BROWSER PAGE, AND WHO HAS TAKEN ONE OVER — the session's control
 * facts as the daemon reports them (`docs/agent-tools.md`), folded into one value.
 *
 * Two sources write it, and they say the same things in two shapes:
 *
 *   `GET …/surfaces/{terminals,browser}/control`  one kind's whole `SurfaceControlView` — the answer to
 *                                                 a page load, a poll and every Take over / Hand back
 *   `surface.*` events on the session journal     one change at a time, as it happens
 *
 * A view REPLACES its kind outright, because it is the daemon's complete answer for that kind. An event
 * is folded into the kind it names. Nothing here is a guess: a kind the daemon has not answered for is
 * `null` — not read, or not readable by this device (no `terminal` / `browser` grant) — which is a
 * different state from an empty view, and is read as "nobody is driving, nothing is held" only because
 * that is the one reading that offers no control the daemon would refuse.
 *
 * DRIVING LAPSES ON ITS OWN. A `surface.driving` record carries `until`, and the marker is shown only
 * while `now < until`: the daemon republishes before then while the agent keeps acting, and sends
 * nothing when it stops. So every question about driving takes `now`, and `nextDrivingLapse` says when
 * the answer next changes without any event arriving.
 *
 * A SURFACE IS ADDRESSED BY ITS ID OR ITS NAME. The daemon keys everything by id (a name can be reused
 * by the next terminal opened after this one closes), while a workspace tab or a `%terminal:dev`
 * reference may hold either; `key` matches the id, or the name when the record carries one.
 */

import {
  type FyEvent,
  SURFACE_EVENT_TYPES,
  type SurfaceControlView,
  type SurfaceDriving,
  SurfaceDrivingSchema,
  SurfaceHandbackSchema,
  type SurfaceHanded,
  SurfaceHandedSchema,
  type SurfaceKind,
  type SurfaceTakeover,
  SurfaceTakeoverSchema,
} from '@ferretry/protocol';

/** Each kind's control view, or null while the daemon has not answered for it. */
export interface SurfaceControlState {
  readonly terminal: SurfaceControlView | null;
  readonly browser: SurfaceControlView | null;
}

export const UNREAD_SURFACE_CONTROL: SurfaceControlState = Object.freeze({ terminal: null, browser: null });

/** Does `key` (an id, or a name) address this record? */
const addresses = (record: { readonly id: string; readonly name?: string }, key: string): boolean =>
  record.id === key || record.name === key;

/**
 * One kind's view, as the daemon answered it. A view for another session is not this session's answer
 * — a crossed or stale response — and changes nothing.
 */
export const withSurfaceControlView = (
  state: SurfaceControlState,
  sessionId: string,
  kind: SurfaceKind,
  view: SurfaceControlView,
): SurfaceControlState => (view.sessionId === sessionId ? { ...state, [kind]: view } : state);

const emptyView = (sessionId: string): SurfaceControlView => ({ sessionId, driving: [], takeovers: [], handed: [] });

/** Replaces the record with the same id, or appends it. */
const upsert = <T extends { readonly id: string }>(records: readonly T[], next: T): T[] => [
  ...records.filter(record => record.id !== next.id),
  next,
];

const withoutId = <T extends { readonly id: string }>(records: readonly T[], id: string): T[] =>
  records.filter(record => record.id !== id);

/** The kind an event names, and its view to change — an unread kind starts from an empty one. */
const viewFor = (state: SurfaceControlState, sessionId: string, kind: SurfaceKind): SurfaceControlView =>
  state[kind] ?? emptyView(sessionId);

const foldDriving = (state: SurfaceControlState, sessionId: string, driving: SurfaceDriving): SurfaceControlState => {
  const view = viewFor(state, sessionId, driving.surface);
  // A held surface is not being driven, whatever an out-of-order record says: the daemon refuses
  // every agent act on it until the person hands it back.
  if (view.takeovers.some(takeover => takeover.id === driving.id)) return state;
  return { ...state, [driving.surface]: { ...view, driving: upsert(view.driving, driving) } };
};

const foldTakeover = (
  state: SurfaceControlState,
  sessionId: string,
  takeover: SurfaceTakeover,
): SurfaceControlState => {
  const view = viewFor(state, sessionId, takeover.surface);
  return {
    ...state,
    [takeover.surface]: {
      ...view,
      // The daemon drops the agent's marker the moment a person takes the surface.
      driving: withoutId(view.driving, takeover.id),
      takeovers: upsert(view.takeovers, takeover),
    },
  };
};

const foldHanded = (state: SurfaceControlState, sessionId: string, handed: SurfaceHanded): SurfaceControlState => {
  const view = viewFor(state, sessionId, handed.surface);
  return { ...state, [handed.surface]: { ...view, handed: upsert(view.handed, handed) } };
};

/**
 * Folds one journal event into the state. Anything that is not a well-formed `surface.*` record for
 * THIS session changes nothing — the feed carries every other kind of event too.
 */
export const applySurfaceEvent = (
  state: SurfaceControlState,
  sessionId: string,
  event: FyEvent,
): SurfaceControlState => {
  if (event.sessionId !== sessionId) return state;
  switch (event.type) {
    case SURFACE_EVENT_TYPES.driving: {
      const parsed = SurfaceDrivingSchema.safeParse(event.data);
      return parsed.success ? foldDriving(state, sessionId, parsed.data) : state;
    }
    case SURFACE_EVENT_TYPES.takeover: {
      const parsed = SurfaceTakeoverSchema.safeParse(event.data);
      return parsed.success ? foldTakeover(state, sessionId, parsed.data) : state;
    }
    case SURFACE_EVENT_TYPES.handback: {
      const parsed = SurfaceHandbackSchema.safeParse(event.data);
      if (!parsed.success) return state;
      const view = viewFor(state, sessionId, parsed.data.surface);
      return { ...state, [parsed.data.surface]: { ...view, takeovers: withoutId(view.takeovers, parsed.data.id) } };
    }
    case SURFACE_EVENT_TYPES.handed: {
      const parsed = SurfaceHandedSchema.safeParse(event.data);
      return parsed.success ? foldHanded(state, sessionId, parsed.data) : state;
    }
    default:
      return state;
  }
};

/** Whether this event is one of the four control records — the feed's cue to fold it in. */
export const isSurfaceControlEvent = (event: FyEvent): boolean =>
  (Object.values(SURFACE_EVENT_TYPES) as readonly string[]).includes(event.type);

/** The person's hold on a surface, if one stands. */
export const surfaceTakeoverFor = (
  state: SurfaceControlState,
  kind: SurfaceKind,
  key: string,
): SurfaceTakeover | undefined => state[kind]?.takeovers.find(takeover => addresses(takeover, key));

/** The agent driving a surface right now — its marker unlapsed, and nobody holding the surface. */
export const surfaceDrivingFor = (
  state: SurfaceControlState,
  kind: SurfaceKind,
  key: string,
  now: number,
): SurfaceDriving | undefined => {
  if (surfaceTakeoverFor(state, kind, key) !== undefined) return undefined;
  return state[kind]?.driving.find(driving => addresses(driving, key) && Date.parse(driving.until) > now);
};

/** Every surface an agent is driving right now, of both kinds. */
export const activeSurfaceDriving = (state: SurfaceControlState, now: number): readonly SurfaceDriving[] =>
  (['terminal', 'browser'] as const).flatMap(kind =>
    (state[kind]?.driving ?? []).filter(driving => surfaceDrivingFor(state, kind, driving.id, now) === driving),
  );

/**
 * When the next standing marker lapses, as epoch milliseconds — the instant the answer to "who is
 * driving" changes with no event at all — or undefined when no marker is standing.
 */
export const nextDrivingLapse = (state: SurfaceControlState, now: number): number | undefined => {
  const lapses = activeSurfaceDriving(state, now).map(driving => Date.parse(driving.until));
  return lapses.length === 0 ? undefined : Math.min(...lapses);
};

/** What a person calls the agent driving a surface: its name, or a plain stand-in when it has none. */
export const drivingAgentName = (driving: SurfaceDriving): string => driving.agentName ?? 'The agent';

/**
 * A session page's share of its host's live feed: the host publishes every event it receives, and the
 * page's control seam subscribes. One subscription to `/v1/events` per session, however many readers.
 */
export interface SurfaceEventHub {
  readonly subscribe: (listener: (event: FyEvent) => void) => () => void;
  readonly publish: (event: FyEvent) => void;
}

export const createSurfaceEventHub = (): SurfaceEventHub => {
  const listeners = new Set<(event: FyEvent) => void>();
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: event => {
      for (const listener of [...listeners]) listener(event);
    },
  };
};
