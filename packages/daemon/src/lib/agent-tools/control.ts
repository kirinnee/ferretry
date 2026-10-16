import {
  SURFACE_EVENT_TYPES,
  type SurfaceController,
  type SurfaceControlView,
  type SurfaceDriving,
  type SurfaceHandback,
  type SurfaceKind,
  type SurfaceTakeover,
} from '@ferretry/protocol';
import type { AgentToolClock, ResolvedSurface, SurfaceEventSink } from './types.ts';

/**
 * WHO IS DRIVING EACH SURFACE, AND WHO HAS TAKEN ONE OVER.
 *
 * DRIVING is the "AGENT · Hadi is typing here" marker. It is published as a `surface.driving` event
 * carrying `until`, the instant it lapses unless the agent acts again, so a reader shows it while
 * `now < until` and needs no second event to clear it. An agent acting on a surface every second
 * would otherwise write an event a second; instead one is written only when the marker would lapse
 * within half its window, which bounds the journal to about one event per surface per
 * {@link DRIVING_WINDOW_MS}/2 however busy the agent is.
 *
 * A TAKEOVER is a person holding a surface. While it stands, every agent tool call on that surface is
 * refused — the check is in the daemon, on the tool path, so an agent cannot talk its way past it —
 * until the person hands it back. Takeovers are held in memory: a daemon restart drops every
 * terminal viewer and browser viewer as well, and a person who still wants control takes it again.
 *
 * Both are keyed by the surface's ID, not its name: a name can be reused by the next terminal opened
 * after this one closes, and a takeover of the old shell must not follow its name to the new one.
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

  constructor(
    private readonly events: SurfaceEventSink,
    private readonly clock: AgentToolClock,
  ) {}

  /** The takeover standing on this surface, if a person holds it. */
  takeoverOf(sessionId: string, surface: ResolvedSurface): SurfaceTakeover | undefined {
    return this.#takeovers.get(keyOf(sessionId, surface.surface, surface.id))?.value;
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
      since: current?.since ?? new Date(now).toISOString(),
      until: new Date(now + DRIVING_WINDOW_MS).toISOString(),
    };
    this.#driving.set(key, { sessionId, value: driving });
    await this.events.publish(sessionId, SURFACE_EVENT_TYPES.driving, driving);
  }

  /** A person takes a surface: the agent's marker goes, and its tool calls on it are refused. */
  async takeover(sessionId: string, surface: ResolvedSurface, by: SurfaceController): Promise<SurfaceTakeover> {
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
    const key = keyOf(sessionId, surface.surface, surface.id);
    if (!this.#takeovers.delete(key)) return;
    const handback: SurfaceHandback = {
      surface: surface.surface,
      id: surface.id,
      ...(surface.name === undefined ? {} : { name: surface.name }),
      at: new Date(this.clock.now()).toISOString(),
    };
    await this.events.publish(sessionId, SURFACE_EVENT_TYPES.handback, handback);
  }

  /** A surface that closed: nothing about it stands any more. */
  forget(sessionId: string, surface: ResolvedSurface): void {
    const key = keyOf(sessionId, surface.surface, surface.id);
    this.#driving.delete(key);
    this.#takeovers.delete(key);
  }

  /** Every live marker and standing takeover in one session. */
  view(sessionId: string): SurfaceControlView {
    this.#prune(this.clock.now());
    const of = <T>(held: Map<string, Held<T>>): T[] =>
      [...held.values()].filter(entry => entry.sessionId === sessionId).map(entry => entry.value);
    return { sessionId, driving: of(this.#driving), takeovers: of(this.#takeovers) };
  }

  /** Drops lapsed markers, so a session that stopped acting leaves nothing behind in memory. */
  #prune(now: number): void {
    for (const [key, held] of this.#driving) if (Date.parse(held.value.until) <= now) this.#driving.delete(key);
  }
}
