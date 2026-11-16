import type { SurfaceOpener } from '../../../contract/index.ts';
import type { SurfaceKind } from '../protocol/surface-control.ts';

/**
 * The terminal agent tools' seams (today's `lib/agent-tools/types.ts`, the terminal part).
 *
 * WHO IS CALLING A TOOL — derived by the kernel and Gate, never stated by the caller. `agent` is a ferret that proved
 * which one it is with its own credential; its ferret is that credential's and nothing else. `person` is somebody
 * using the CLI or the app against a ferret they named, already admitted by the route's grants.
 */
export type AgentToolCaller =
  | {
      readonly kind: 'agent';
      readonly sessionId: string;
      /** The ferret's display name (`Hadi`), for "Hadi is typing here". */
      readonly name?: string;
    }
  | {
      readonly kind: 'person';
      readonly sessionId: string;
      /** Who the terminal a person opens is recorded as opened by; absent when nothing can be attested. */
      readonly openedBy?: SurfaceOpener;
    };

/** One control event, as the store hands it back. */
export interface RecordedSurfaceEvent {
  readonly type: string;
  readonly data: unknown;
}

/** Where control changes are kept, so a takeover or a hand-over outlives a daemon restart. */
export interface SurfaceEventSink {
  publish(sessionId: string, type: string, data: unknown): Promise<void>;
  /** This ferret's earlier `surface.*` events, oldest first. */
  history(sessionId: string): Promise<readonly RecordedSurfaceEvent[]>;
}

export interface AgentToolClock {
  now(): number;
}

/** One surface, resolved from the name or id a call used. */
export interface ResolvedSurface {
  readonly surface: SurfaceKind;
  readonly id: string;
  readonly name?: string;
  /** Who opened it, when the daemon can attest that. */
  readonly openedBy?: SurfaceOpener;
  /** A browser page in its own throwaway context (never a terminal; kept so the stored events keep their shape). */
  readonly incognito?: true;
}
