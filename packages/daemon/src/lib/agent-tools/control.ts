import {
  SURFACE_EVENT_TYPES,
  type SurfaceController,
  type SurfaceControlView,
  type SurfaceDriving,
  type SurfaceHanded,
  SurfaceHandedSchema,
  SurfaceHandbackSchema,
  type SurfaceKind,
  type SurfaceTakeover,
  SurfaceTakeoverSchema,
} from '@ferretry/protocol';
import type { AgentToolClock, ResolvedSurface, SurfaceEventSink } from './types.ts';

/**
 * WHO IS DRIVING EACH SURFACE, WHO HAS TAKEN ONE OVER, AND WHAT WAS HANDED TO THE AGENT.
 *
 * DRIVING is the "AGENT · Hadi is typing here" marker. It is published as a `surface.driving` event
 * carrying `until`, the instant it lapses unless the agent acts again, so a reader shows it while
 * `now < until` and needs no second event to clear it. One is written only when the standing marker
 * would lapse within half its window, which bounds the journal to about one event per surface per
 * {@link DRIVING_WINDOW_MS}/2 however busy the agent is.
 *
 * A TAKEOVER is a person holding a surface; a HAND-OVER is a person giving the agent a surface they
 * opened. Both are journaled (`surface.takeover`, `surface.handback`, `surface.handed`) and REPLAYED
 * from the session's journal the first time a session is asked about after a start, so a person who
 * took a shell over is still holding it after the daemon restarts. A driving marker is not replayed:
 * it lapses within seconds anyway.
 *
 * Everything is keyed by the surface's ID, not its name: a name can be reused by the next terminal
 * opened after this one closes, and a takeover of the old shell must not follow its name to the new one.
 */

/** How long one action keeps the driving marker up. */
export const DRIVING_WINDOW_MS = 15_000;

const keyOf = (sessionId: string, surface: SurfaceKind, id: string): string => `${sessionId}\n${surface}\n${id}`;

interface Held<T> {
  readonly sessionId: string;
  readonly value: T;
}

export class SurfaceControl {
  readonly #driving = new Map<string, Held<SurfaceDriving>>();
  readonly #takeovers = new Map<string, Held<SurfaceTakeover>>();
  readonly #handed = new Map<string, Held<SurfaceHanded>>();
  readonly #loaded = new Map<string, Promise<void>>();

  constructor(
    private readonly events: SurfaceEventSink,
    private readonly clock: AgentToolClock,
  ) {}

  /** The takeover standing on this surface, if a person holds it. */
  async takeoverOf(sessionId: string, surface: ResolvedSurface): Promise<SurfaceTakeover | undefined> {
    await this.#load(sessionId);
    return this.#takeovers.get(keyOf(sessionId, surface.surface, surface.id))?.value;
  }

  /** Whether a person handed this surface to the agent. */
  async isHanded(sessionId: string, surface: ResolvedSurface): Promise<boolean> {
    await this.#load(sessionId);
    return this.#handed.has(keyOf(sessionId, surface.surface, surface.id));
  }

  /**
   * Records that an agent acted on a surface, publishing a fresh marker only when the standing one
   * is missing or about to lapse.
   */
  async drove(sessionId: string, surface: ResolvedSurface, agent: { readonly name?: string }): Promise<void> {
    const now = this.clock.now();
    this.#prune(now);
    const key = keyOf(sessionId, surface.surface, surface.id);
    const current = this.#driving.get(key)?.value;
    if (current !== undefined && Date.parse(current.until) - now > DRIVING_WINDOW_MS / 2) return;
    const driving: SurfaceDriving = {
      surface: surface.surface,
      id: surface.id,
      ...(surface.name === undefined ? {} : { name: surface.name }),
      agentSessionId: sessionId,
      ...(agent.name === undefined ? {} : { agentName: agent.name }),
      ...(surface.incognito === true ? { incognito: true } : {}),
      since: current?.since ?? new Date(now).toISOString(),
      until: new Date(now + DRIVING_WINDOW_MS).toISOString(),
    };
    this.#driving.set(key, { sessionId, value: driving });
    await this.events.publish(sessionId, SURFACE_EVENT_TYPES.driving, driving);
  }

  /** A person takes a surface: the agent's marker goes, and its tool calls on it are refused. */
  async takeover(sessionId: string, surface: ResolvedSurface, by: SurfaceController): Promise<SurfaceTakeover> {
    await this.#load(sessionId);
    const key = keyOf(sessionId, surface.surface, surface.id);
    const standing = this.#takeovers.get(key)?.value;
    if (standing !== undefined) return standing;
    const takeover: SurfaceTakeover = {
      surface: surface.surface,
      id: surface.id,
      ...(surface.name === undefined ? {} : { name: surface.name }),
      by,
      since: new Date(this.clock.now()).toISOString(),
    };
    this.#driving.delete(key);
    this.#takeovers.set(key, { sessionId, value: takeover });
    await this.events.publish(sessionId, SURFACE_EVENT_TYPES.takeover, takeover);
    return takeover;
  }

  /** The person hands the surface back. Handing back one nobody holds changes nothing. */
  async handback(sessionId: string, surface: ResolvedSurface): Promise<void> {
    await this.#load(sessionId);
    if (!this.#takeovers.delete(keyOf(sessionId, surface.surface, surface.id))) return;
    await this.events.publish(sessionId, SURFACE_EVENT_TYPES.handback, {
      surface: surface.surface,
      id: surface.id,
      ...(surface.name === undefined ? {} : { name: surface.name }),
      at: new Date(this.clock.now()).toISOString(),
    });
  }

  /** A person gives the agent a surface they opened. Handing one twice changes nothing. */
  async hand(sessionId: string, surface: ResolvedSurface, by: SurfaceController): Promise<void> {
    await this.#load(sessionId);
    const key = keyOf(sessionId, surface.surface, surface.id);
    if (this.#handed.has(key)) return;
    const handed: SurfaceHanded = {
      surface: surface.surface,
      id: surface.id,
      ...(surface.name === undefined ? {} : { name: surface.name }),
      by,
      at: new Date(this.clock.now()).toISOString(),
    };
    this.#handed.set(key, { sessionId, value: handed });
    await this.events.publish(sessionId, SURFACE_EVENT_TYPES.handed, handed);
  }

  /** A surface that closed: nothing about it stands any more. */
  forget(sessionId: string, surface: ResolvedSurface): void {
    const key = keyOf(sessionId, surface.surface, surface.id);
    this.#driving.delete(key);
    this.#takeovers.delete(key);
    this.#handed.delete(key);
  }

  /** Every live marker, standing takeover and hand-over of one kind in one session. */
  async view(sessionId: string, surface: SurfaceKind): Promise<SurfaceControlView> {
    await this.#load(sessionId);
    this.#prune(this.clock.now());
    const of = <T extends { readonly surface: SurfaceKind }>(held: Map<string, Held<T>>): T[] =>
      [...held.values()]
        .filter(entry => entry.sessionId === sessionId && entry.value.surface === surface)
        .map(entry => entry.value);
    return {
      sessionId,
      driving: of(this.#driving),
      takeovers: of(this.#takeovers),
      handed: of(this.#handed),
    };
  }

  /** Rebuilds a session's takeovers and hand-overs from its journal, once per daemon run. */
  async #load(sessionId: string): Promise<void> {
    let loading = this.#loaded.get(sessionId);
    if (loading === undefined) {
      // A journal that could not be read is asked again next time, rather than remembered as empty:
      // an empty history would read every standing takeover as released.
      loading = this.#replay(sessionId).catch((error: unknown) => {
        this.#loaded.delete(sessionId);
        throw error;
      });
      this.#loaded.set(sessionId, loading);
    }
    await loading;
  }

  async #replay(sessionId: string): Promise<void> {
    for (const event of await this.events.history(sessionId)) {
      if (event.type === SURFACE_EVENT_TYPES.takeover) {
        const takeover = SurfaceTakeoverSchema.safeParse(event.data);
        if (takeover.success)
          this.#takeovers.set(keyOf(sessionId, takeover.data.surface, takeover.data.id), {
            sessionId,
            value: takeover.data,
          });
      } else if (event.type === SURFACE_EVENT_TYPES.handback) {
        const handback = SurfaceHandbackSchema.safeParse(event.data);
        if (handback.success) this.#takeovers.delete(keyOf(sessionId, handback.data.surface, handback.data.id));
      } else if (event.type === SURFACE_EVENT_TYPES.handed) {
        const handed = SurfaceHandedSchema.safeParse(event.data);
        if (handed.success)
          this.#handed.set(keyOf(sessionId, handed.data.surface, handed.data.id), { sessionId, value: handed.data });
      }
    }
  }

  /** Drops lapsed markers, so a session that stopped acting leaves nothing behind in memory. */
  #prune(now: number): void {
    for (const [key, held] of this.#driving) if (Date.parse(held.value.until) <= now) this.#driving.delete(key);
  }
}
