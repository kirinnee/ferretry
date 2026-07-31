/** A cancellable one-shot timer handed back by the clock port. */
export interface FrameTimer {
  cancel(): void;
}

/** The only time source the transport domain may touch; the adapter owns real timers. */
export interface FrameClock {
  /** Monotonic-enough milliseconds; only differences are ever compared. */
  now(): number;
  schedule(callback: () => void, delayMs: number): FrameTimer;
}

/**
 * The byte sink a captured frame is written to — the worker's standard output in production.
 *
 * `write` returns `false` when the frame was accepted but the sink is now full, matching the
 * stream-writer contract every runtime shares. `watchDrain` is optional: a sink that cannot signal
 * recovery makes the governor fall back to interval retries rather than stalling forever.
 */
export interface FrameSink<TFrame> {
  write(frame: TFrame): boolean;
  watchDrain?(listener: () => void): () => void;
}

/** Releases one captured frame back to the capture source, unblocking its next frame. */
export type FrameAcknowledgement = () => void | Promise<void>;

export interface FrameGovernorOptions {
  /** Floor on the interval between emitted frames. */
  readonly minIntervalMs?: number;
  /** How many un-acknowledged frames may be held while the sink is blocked. */
  readonly maxHeldAcknowledgements?: number;
  /**
   * Called once per session when an acknowledgement cannot be delivered or the capture source
   * exceeded its acknowledgement window. The adapter rebinds the session rather than growing memory.
   */
  readonly onAcknowledgementRejected?: (session: string) => void;
}

/** Everything a test or a status endpoint needs to reason about the governor, and nothing more. */
export interface FrameGovernorSnapshot<TFrame> {
  readonly activeSession?: string;
  readonly pendingFrame?: TFrame;
  readonly heldAcknowledgements: number;
  readonly timerArmed: boolean;
  readonly sinkWritable: boolean;
  readonly lastOutputAt?: number;
}
