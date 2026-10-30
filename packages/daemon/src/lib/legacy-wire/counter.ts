import type { LegacyWireUse } from '@ferretry/protocol';
import type {
  LegacyWireDiagnostics,
  LegacyWireHit,
  LegacyWireTimers,
  LegacyWireUseRecorder,
  LegacyWireUseStore,
} from './ports.ts';

/** The least time between two writes of the counter's file. */
export const LEGACY_WIRE_WRITE_INTERVAL_MS = 60_000;

/** A client version is a caller-chosen header; keep only what a doctor line could usefully show. */
const MAX_CLIENT_VERSION_LENGTH = 64;

const instantMs = (value: string): number => Date.parse(value);

function cleanVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim().slice(0, MAX_CLIENT_VERSION_LENGTH);
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function merge(left: LegacyWireUse, right: LegacyWireUse): LegacyWireUse {
  const later = instantMs(right.lastAt) >= instantMs(left.lastAt) ? right : left;
  return {
    route: left.route,
    firstAt: instantMs(right.firstAt) < instantMs(left.firstAt) ? right.firstAt : left.firstAt,
    lastAt: later.lastAt,
    count: left.count + right.count,
    ...(later.lastClientVersion === undefined ? {} : { lastClientVersion: later.lastClientVersion }),
  };
}

/**
 * Counts the hits on routes the daemon keeps only for older clients, so the release that removes them can
 * wait for a fortnight of silence (docs/agenda.md § Compatibility).
 *
 * `record` is synchronous, memory-only and cannot throw, so the dispatcher never waits on it. The file is
 * written at most once a minute — the first hit after a quiet spell writes at once — and `flush` writes what
 * is pending, for shutdown. A write that fails is said once and left pending: the next hit schedules
 * another, so a read-only disk costs one line, not a line a minute.
 */
export class LegacyWireUseCounter implements LegacyWireUseRecorder {
  readonly #uses = new Map<string, LegacyWireUse>();
  #dirty = false;
  #lastWriteAt: number | undefined;
  #cancel: (() => void) | undefined;
  #writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: LegacyWireUseStore,
    private readonly timers: LegacyWireTimers,
    private readonly diagnostics: LegacyWireDiagnostics,
  ) {}

  /** Merges what an earlier run saved into what this one has counted. Call once, before serving. */
  async load(): Promise<void> {
    let saved: readonly LegacyWireUse[];
    try {
      saved = await this.store.load();
    } catch (error) {
      this.diagnostics.warn(`legacy wire use could not be loaded: ${describe(error)}`);
      return;
    }
    for (const use of saved) {
      const present = this.#uses.get(use.route);
      this.#uses.set(use.route, present === undefined ? use : merge(present, use));
    }
  }

  record(hit: LegacyWireHit): void {
    try {
      const version = cleanVersion(hit.clientVersion);
      const at = new Date(this.timers.now()).toISOString();
      const present = this.#uses.get(hit.route);
      this.#uses.set(
        hit.route,
        merge(present ?? { route: hit.route, firstAt: at, lastAt: at, count: 0 }, {
          route: hit.route,
          firstAt: at,
          lastAt: at,
          count: 1,
          ...(version === undefined ? {} : { lastClientVersion: version }),
        }),
      );
      this.#dirty = true;
      this.#schedule();
    } catch (error) {
      this.diagnostics.warn(`legacy wire use was not counted: ${describe(error)}`);
    }
  }

  /** Every route that has been used, by route name. */
  snapshot(): readonly LegacyWireUse[] {
    return [...this.#uses.values()].sort((a, b) => a.route.localeCompare(b.route));
  }

  /** Writes what is pending now, and resolves once it is on disk (or said to have failed). */
  async flush(): Promise<void> {
    this.#cancelTimer();
    await this.#write();
  }

  #schedule(): void {
    if (this.#cancel !== undefined) return;
    const since = this.#lastWriteAt === undefined ? Infinity : this.timers.now() - this.#lastWriteAt;
    const delay = Math.max(0, LEGACY_WIRE_WRITE_INTERVAL_MS - since);
    this.#cancel = this.timers.after(delay, () => {
      this.#cancel = undefined;
      void this.#write();
    });
  }

  #cancelTimer(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #write(): Promise<void> {
    this.#writing = this.#writing.then(async () => {
      if (!this.#dirty) return;
      this.#dirty = false;
      this.#lastWriteAt = this.timers.now();
      try {
        await this.store.save(this.snapshot());
      } catch (error) {
        this.#dirty = true;
        this.diagnostics.warn(`legacy wire use could not be saved: ${describe(error)}`);
      }
    });
    return this.#writing;
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
