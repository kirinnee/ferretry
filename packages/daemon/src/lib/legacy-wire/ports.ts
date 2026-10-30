import type { LegacyWireUse } from '@ferretry/protocol';

/** One request that reached a route marked `legacy: true` (the counter stamps it with its own clock). */
export interface LegacyWireHit {
  /** `<METHOD> <path pattern>`, as the route is declared — never the concrete path a caller sent. */
  readonly route: string;
  /** The caller's `x-fy-version`, when it sent one. */
  readonly clientVersion?: string;
}

/**
 * Where the dispatcher reports a legacy-route hit. `record` returns nothing and must not throw: a request
 * never waits on, or fails because of, the counter that watches it.
 */
export interface LegacyWireUseRecorder {
  record(hit: LegacyWireHit): void;
}

/** The counter's durable copy. */
export interface LegacyWireUseStore {
  /** What was saved. A file that cannot be read or parsed is the store's to report and answers `[]`. */
  load(): Promise<readonly LegacyWireUse[]>;
  save(uses: readonly LegacyWireUse[]): Promise<void>;
}

/** The counter's clock and timer, so a unit can drive time. `after` returns its own cancel. */
export interface LegacyWireTimers {
  now(): number;
  after(delayMs: number, run: () => void): () => void;
}

/** Where a counter problem is said out loud; never an error to the caller. */
export interface LegacyWireDiagnostics {
  warn(message: string): void;
}
