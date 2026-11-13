import type { SurfaceOpener } from '../../contract/wire/surface.ts';
import type { SurfaceKind } from '../../contract/wire/control.ts';

/**
 * Who calls a browser tool, derived by the half from the kernel-stamped standing, never from the call: a ferret's
 * own call, or a person's (the owner's tools route, the app), always about one ferret's pages.
 */
export type ToolCaller =
  | { readonly kind: 'agent'; readonly sessionId: string; readonly name?: string }
  | { readonly kind: 'person'; readonly sessionId: string; readonly openedBy?: SurfaceOpener };

/** One recorded `surface.*` event. */
export interface RecordedSurfaceEvent {
  readonly type: string;
  readonly data: unknown;
}

/** Where the surface events go and are read back from (today's session journal; here the half's own record). */
export interface SurfaceEventSink {
  publish(sessionId: string, type: string, data: unknown): Promise<void>;
  /** This ferret's earlier `surface.*` events, oldest first. */
  history(sessionId: string): Promise<readonly RecordedSurfaceEvent[]>;
}

export interface ToolClock {
  now(): number;
}

/** One page, resolved from the name or id a call used. */
export interface ResolvedSurface {
  readonly surface: SurfaceKind;
  readonly id: string;
  readonly name?: string;
  /** Who opened it, when the daemon can attest that. */
  readonly openedBy?: SurfaceOpener;
  /** A page in its own throwaway context. */
  readonly incognito?: true;
  /** A popup: the page that opened it. */
  readonly openerId?: string;
  /** Where it was when it was looked up. */
  readonly url?: string;
  /** A page this very call opened. */
  readonly opened?: true;
}
