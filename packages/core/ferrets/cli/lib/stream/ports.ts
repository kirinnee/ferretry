import type { FyEventStreamFrame } from '../../../contract/index.ts';

/** Where a stream starts: one ferret from a cursor, or (no `ferretId`) the daemon's whole fleet. */
export interface StreamScope {
  readonly ferretId?: string;
  readonly after: number;
}

/**
 * The daemon's journal socket (`GET /v1/events`). Resolves when `signal` aborts (the caller left); rejects when the
 * socket ends any other way, or a frame is not one the daemon's schema allows. A throw from `onFrame` ends it too.
 */
export interface IEventStream {
  follow(scope: StreamScope, onFrame: (frame: FyEventStreamFrame) => void, signal: AbortSignal): Promise<void>;
}

/** Terminal output for a stream: `success` is stdout (events), `error` is stderr (notes). */
export interface IStreamIo {
  success(message: string): void;
  error(message: string): void;
}
