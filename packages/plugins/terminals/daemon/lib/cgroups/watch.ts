/**
 * Watching the fleet's memory, on a timer and never per request.
 *
 * LINUX reads the kernel's own counters (`memory.events`) for the fleet slice and each agent scope. A
 * ferret is SLOWED when `high` rose since the last look and KILLED when `oom_kill` did. A first look is
 * a baseline. When a ferret's own agent is the thing killed its scope vanishes with it, so the fleet
 * slice's counter — which keeps what its children counted — is what says a kill happened, and the
 * scope that vanished while under pressure is who it is blamed on.
 *
 * WHAT WAS USING THE MEMORY is looked up only for scopes that are close to their soft limit, from the
 * process tree, so the common case reads two small files per ferret and walks nothing. A kill reports
 * the biggest process seen at the last pressured look.
 *
 * MACOS has no counters. The same timer sums each ferret's process-tree resident memory and REPORTS a
 * ferret over its per-ferret share. Nothing is capped there, and every word says so.
 *
 * Each ferret hears about it once per episode (a note in its own journal), not once per tick.
 */
import type { ResolvedLimits } from '../protocol/limits.ts';
import { eventsGrowth } from './memory-events.ts';
import type {
  AppliedCaps,
  FleetMemoryPort,
  MemoryEvents,
  ScopeSighting,
  SessionMemoryPort,
  SessionNotePort,
  TreeProcess,
} from './ports.ts';
import { sessionOfScope, sessionOfSlice } from './scope.ts';

const sessionOfGroup = (name: string): string | undefined => sessionOfSlice(name) ?? sessionOfScope(name);

/** How often the limits timer looks at the fleet's memory. */
export const LIMITS_TICK_MS = 30_000;

/** How long after `high` last rose a ferret still counts as slowed. Two ticks of the default period. */
export const THROTTLE_MEMORY_MS = 90_000;
/** A scope this close to its soft limit is worth looking inside, so a kill can say what was running. */
const PRESSURE_FRACTION = 0.7;
const KEPT_KILLS = 20;

interface SlowedFerret {
  readonly sessionId: string;
  readonly callsign?: string;
}

export interface KilledFerret {
  readonly sessionId?: string;
  readonly callsign?: string;
  /** When the kill was noticed (ISO). */
  readonly at: string;
  readonly what?: string;
  readonly bytes?: number;
}

export interface OverBudgetFerret {
  readonly sessionId: string;
  readonly callsign?: string;
  readonly bytes: number;
}

/** What the watcher knows now. */
/** What the kernel says the fleet slice and each running ferret were actually given. */
export interface AppliedLimits {
  readonly fleet?: AppliedCaps;
  readonly scopes: readonly AppliedCaps[];
}

export interface MemoryWatchState {
  readonly throttled: readonly SlowedFerret[];
  /** The ferrets together went past the fleet's soft memory limit and are all being slowed, whoever holds the memory. */
  readonly fleetSlowed: boolean;
  /** Read back from the cgroup files on the last look; absent before one (or where there is no slice yet). */
  readonly applied?: AppliedLimits;
  readonly killed: readonly KilledFerret[];
  readonly overBudget: readonly OverBudgetFerret[];
}

interface ScopeMemory {
  events: MemoryEvents;
  throttledAt?: number;
  /** The biggest process at the last pressured look. */
  seen?: { readonly what: string; readonly bytes: number };
  lastCurrent: number;
}

export interface MemoryWatchPorts {
  readonly fleet: FleetMemoryPort;
  readonly memory: SessionMemoryPort;
  readonly notes: SessionNotePort;
  readonly now: () => number;
  readonly iso: (ms: number) => string;
}

/** `bun test --coverage` → `bun test`: the program and its first word, short enough for a sentence. */
export function describeProcess(biggest: TreeProcess): string {
  const words = biggest.argv.trim().split(/\s+/u).filter(Boolean);
  const program = (words[0] ?? '').split('/').at(-1) ?? '';
  const second = words[1] !== undefined && !words[1].startsWith('-') ? ` ${words[1].split('/').at(-1)}` : '';
  return `${program}${second}`.slice(0, 48) || 'a process';
}

export class FleetMemoryWatcher {
  private readonly scopes = new Map<string, ScopeMemory>();
  private fleetEvents: MemoryEvents | undefined;
  private fleetLocalEvents: MemoryEvents | undefined;
  private browserEvents: MemoryEvents | undefined;
  private fleetSlowedAt: number | undefined;
  private fleetNotified = false;
  private applied: AppliedLimits | undefined;
  private killed: KilledFerret[] = [];
  private overBudget: OverBudgetFerret[] = [];
  private readonly lastKillAt = new Map<string, number>();
  private readonly overNotified = new Set<string>();

  constructor(private readonly ports: MemoryWatchPorts) {}

  /** One look at the kernel's counters (Linux). Never throws. */
  async tickLinux(): Promise<void> {
    try {
      const sighting = await this.ports.fleet.read();
      if (sighting === undefined) {
        this.applied = undefined;
        return;
      }
      const now = this.ports.now();
      const seen = new Set<string>();
      const browserGrowth =
        sighting.browserEvents === undefined ? undefined : eventsGrowth(this.browserEvents, sighting.browserEvents);
      let accounted = browserGrowth?.oomKill ?? 0;
      const nowScopes: Array<{ id: string; scope: ScopeSighting }> = [];
      for (const scope of sighting.scopes) {
        const id = sessionOfGroup(scope.scope);
        if (id !== undefined) nowScopes.push({ id, scope });
      }
      const appliedBySession = new Map<string, AppliedCaps>();
      for (const { id, scope } of nowScopes) appliedBySession.set(id, scope.applied ?? {});
      this.applied = {
        ...(sighting.applied === undefined ? {} : { fleet: sighting.applied }),
        scopes: [...appliedBySession.values()],
      };
      let childHighGrowth = browserGrowth?.high ?? 0;
      const notified = new Set<string>();
      const slowedSessions = new Set<string>();
      for (const [name, state] of this.scopes) {
        const id = sessionOfGroup(name);
        if (id !== undefined && state.throttledAt !== undefined && now - state.throttledAt <= THROTTLE_MEMORY_MS)
          slowedSessions.add(id);
      }
      for (const { id, scope } of nowScopes) {
        seen.add(scope.scope);
        const previous = this.scopes.get(scope.scope);
        const growth = eventsGrowth(previous?.events, scope.events);
        childHighGrowth += growth.high;
        const state: ScopeMemory = previous ?? { events: scope.events, lastCurrent: 0 };
        state.events = scope.events;
        state.lastCurrent = scope.currentBytes ?? 0;
        this.scopes.set(scope.scope, state);
        if (growth.high > 0) {
          const first = !slowedSessions.has(id);
          slowedSessions.add(id);
          state.throttledAt = now;
          if (first && !notified.has(id)) {
            notified.add(id);
            void this.safeNote(id, 'memory_throttled', {});
          }
        }
        const pressured =
          growth.high > 0 ||
          (scope.highBytes !== undefined &&
            scope.currentBytes !== undefined &&
            scope.currentBytes >= scope.highBytes * PRESSURE_FRACTION);
        if (pressured) {
          const biggest = (await this.ports.fleet.largest(scope.scope).catch(() => []))[0];
          if (biggest !== undefined) state.seen = { what: describeProcess(biggest), bytes: biggest.rssBytes };
        }
        if (growth.oomKill > 0) {
          accounted += growth.oomKill;
          await this.recordKill(id, state.seen, now);
        }
      }
      const vanished = [...this.scopes.entries()].filter(([name]) => !seen.has(name));
      const fleetGrowth = eventsGrowth(this.fleetEvents, sighting.events);
      const localHighGrowth =
        sighting.localEvents === undefined
          ? Math.max(0, fleetGrowth.high - childHighGrowth)
          : eventsGrowth(this.fleetLocalEvents, sighting.localEvents).high;
      if (localHighGrowth > 0) {
        // The fleet's own counter: its children's counters do not receive an ancestor's events, so when the
        // ferrets TOGETHER cross the soft limit this is the only place the throttling is visible.
        this.fleetSlowedAt = now;
        if (!this.fleetNotified) {
          this.fleetNotified = true;
          // Only as far as the evidence goes: every ferret running now shares the slowdown, none is singled out.
          for (const { id, scope } of nowScopes)
            if (this.scopes.get(scope.scope)?.throttledAt !== now && !notified.has(id)) {
              notified.add(id);
              void this.safeNote(id, 'memory_throttled', { shared: true });
            }
        }
      } else if (this.fleetSlowedAt === undefined || now - this.fleetSlowedAt > THROTTLE_MEMORY_MS) {
        this.fleetNotified = false;
      }
      const unaccounted = fleetGrowth.oomKill - accounted;
      if (unaccounted > 0) {
        const blamed = vanished
          .map(([name, state]) => ({ id: sessionOfGroup(name), state }))
          .filter((entry): entry is { id: string; state: ScopeMemory } => entry.id !== undefined)
          .sort((left, right) => right.state.lastCurrent - left.state.lastCurrent)[0];
        if (blamed === undefined) await this.recordKill(undefined, undefined, now);
        else await this.recordKill(blamed.id, blamed.state.seen, now);
      }
      for (const [name] of vanished) this.scopes.delete(name);
      this.fleetEvents = sighting.events;
      this.fleetLocalEvents = sighting.localEvents;
      this.browserEvents = sighting.browserEvents;
    } catch {
      // A look that failed changes nothing: the next one starts from the same baseline.
    }
  }

  /** One look at each ferret's resident memory against its share (macOS). Never throws. */
  async tickWatch(limits: ResolvedLimits): Promise<void> {
    try {
      const cap = limits.perFerret.memoryHigh;
      const over: OverBudgetFerret[] = [];
      if (cap !== null)
        for (const sessionId of await this.ports.memory.sessions()) {
          const bytes = await this.ports.memory.total(sessionId).catch(() => undefined);
          if (bytes === undefined || bytes <= cap) continue;
          over.push({ sessionId, bytes, ...(await this.callsignField(sessionId)) });
          if (!this.overNotified.has(sessionId)) {
            this.overNotified.add(sessionId);
            void this.safeNote(sessionId, 'memory_throttled', { bytes, watchedOnly: true });
          }
        }
      for (const id of [...this.overNotified])
        if (!over.some(entry => entry.sessionId === id)) this.overNotified.delete(id);
      this.overBudget = over;
    } catch {
      // see tickLinux
    }
  }

  /** What is true now. */
  async state(): Promise<MemoryWatchState> {
    const now = this.ports.now();
    const throttled: SlowedFerret[] = [];
    for (const [name, scope] of this.scopes) {
      const id = sessionOfGroup(name);
      if (id === undefined || scope.throttledAt === undefined || now - scope.throttledAt > THROTTLE_MEMORY_MS) continue;
      if (!throttled.some(entry => entry.sessionId === id))
        throttled.push({ sessionId: id, ...(await this.callsignField(id)) });
    }
    const fleetSlowed = this.fleetSlowedAt !== undefined && now - this.fleetSlowedAt <= THROTTLE_MEMORY_MS;
    return {
      throttled,
      fleetSlowed,
      killed: [...this.killed],
      overBudget: [...this.overBudget],
      ...(this.applied === undefined ? {} : { applied: this.applied }),
    };
  }

  /** Whether a ferret had a process killed for memory in the last `withinMs`: the end reason asks. */
  killedRecently(sessionId: string, withinMs: number): KilledFerret | undefined {
    const at = this.lastKillAt.get(sessionId);
    if (at === undefined || this.ports.now() - at > withinMs) return undefined;
    return this.killed.findLast(entry => entry.sessionId === sessionId);
  }

  private async recordKill(
    sessionId: string | undefined,
    seen: { readonly what: string; readonly bytes: number } | undefined,
    now: number,
  ): Promise<void> {
    const entry: KilledFerret = {
      at: this.ports.iso(now),
      ...(sessionId === undefined ? {} : { sessionId, ...(await this.callsignField(sessionId)) }),
      ...(seen === undefined ? {} : { what: seen.what, bytes: seen.bytes }),
    };
    this.killed = [...this.killed, entry].slice(-KEPT_KILLS);
    if (sessionId !== undefined) {
      this.lastKillAt.set(sessionId, now);
      await this.safeNote(sessionId, 'memory_killed', {
        ...(seen === undefined ? {} : { what: seen.what, bytes: seen.bytes }),
      });
    }
  }

  private async callsignField(sessionId: string): Promise<{ callsign?: string }> {
    const callsign = await this.ports.notes.callsign(sessionId).catch(() => undefined);
    return callsign === undefined ? {} : { callsign };
  }

  private async safeNote(
    sessionId: string,
    kind: 'memory_throttled' | 'memory_killed',
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.ports.notes.note(sessionId, kind, data).catch(() => undefined);
  }
}
