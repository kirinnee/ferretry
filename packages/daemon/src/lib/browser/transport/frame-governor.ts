import type {
  FrameAcknowledgement,
  FrameClock,
  FrameGovernorOptions,
  FrameGovernorSnapshot,
  FrameSink,
  FrameTimer,
} from './contracts.ts';

/** ~15 frames a second: enough to feel live, cheap enough for a JPEG stream over a socket. */
export const MIN_FRAME_INTERVAL_MS = 66;
/** The capture window a real Chrome screencast keeps open; more than this is a protocol violation. */
export const MAX_HELD_FRAME_ACKNOWLEDGEMENTS = 3;

interface HeldAcknowledgement {
  readonly session: string;
  readonly acknowledge: FrameAcknowledgement;
}

interface PendingFrame<TFrame> {
  readonly session: string;
  readonly frame: TFrame;
}

/**
 * Screencast timing, acknowledgement, and sink-pressure policy, kept away from the browser driver.
 *
 * One session is bound at a time; every retained frame and acknowledgement belongs to that session
 * and is discarded on a rebind. Sink writability is deliberately NOT session-scoped — the sink
 * belongs to the process, so a rebind must not lose the pending drain that is the only wakeup left.
 */
export class BrowserFrameGovernor<TFrame> {
  private readonly minIntervalMs: number;
  private readonly acknowledgementLimit: number;
  private activeSession?: string;
  private pending?: PendingFrame<TFrame>;
  private heldAcknowledgements: HeldAcknowledgement[] = [];
  private timer?: FrameTimer;
  private disposeDrain?: () => void;
  private sinkWritable = true;
  private lastOutputAt?: number;
  private recoverySession?: string;

  constructor(
    private readonly clock: FrameClock,
    private readonly sink: FrameSink<TFrame>,
    private readonly options: FrameGovernorOptions = {},
  ) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? MIN_FRAME_INTERVAL_MS);
    this.acknowledgementLimit = Math.max(
      1,
      Math.floor(options.maxHeldAcknowledgements ?? MAX_HELD_FRAME_ACKNOWLEDGEMENTS),
    );
  }

  /** Starts governing a new capture session, discarding everything the previous one retained. */
  bind(session: string): void {
    this.resetSession();
    this.activeSession = session;
  }

  /**
   * Offers the newest frame. It replaces any frame still waiting: frames are disposable state, and a
   * viewer that fell behind wants the current pixels, not a replay of the ones it missed.
   */
  capture(session: string, frame: TFrame, acknowledge: FrameAcknowledgement): void {
    if (session !== this.activeSession) return;
    if (this.heldAcknowledgements.length >= this.acknowledgementLimit) {
      // kteam retained the frame here and then dropped its acknowledgement, so those bytes stayed in
      // memory unreferenced by any ack. Refuse the frame and let the adapter rebind the session.
      this.reportAcknowledgementFailure(session);
      return;
    }
    this.pending = { session, frame };
    this.heldAcknowledgements.push({ session, acknowledge });
    // While the sink is blocked the drain edge owns the wakeup, and it will emit this frame — by
    // then the freshest one — instead of a timer racing it.
    if (this.sinkWritable) this.schedule();
  }

  /** Ends the current session. Sink pressure survives, because the sink is not session-scoped. */
  stop(): void {
    this.resetSession();
  }

  /**
   * Releases the session and the drain subscription. kteam built a remover for its drain listener
   * and never called it, so a long-lived worker leaked one subscription per blocked write.
   */
  dispose(): void {
    this.resetSession();
    this.disposeDrain?.();
    this.disposeDrain = undefined;
  }

  snapshot(): FrameGovernorSnapshot<TFrame> {
    return {
      ...(this.activeSession === undefined ? {} : { activeSession: this.activeSession }),
      ...(this.pending === undefined ? {} : { pendingFrame: this.pending.frame }),
      heldAcknowledgements: this.heldAcknowledgements.length,
      timerArmed: this.timer !== undefined,
      sinkWritable: this.sinkWritable,
      ...(this.lastOutputAt === undefined ? {} : { lastOutputAt: this.lastOutputAt }),
    };
  }

  private resetSession(): void {
    this.clearTimer();
    this.pending = undefined;
    this.heldAcknowledgements = [];
    this.activeSession = undefined;
    this.lastOutputAt = undefined;
    this.recoverySession = undefined;
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  private reportAcknowledgementFailure(session: string): void {
    if (session !== this.activeSession || this.recoverySession === session) return;
    this.recoverySession = session;
    try {
      this.options.onAcknowledgementRejected?.(session);
    } catch {
      // Recovery is best effort: a later rebind still clears this session's retained state.
    }
  }

  private acknowledge(held: HeldAcknowledgement): void {
    let result: void | Promise<void>;
    try {
      result = held.acknowledge();
    } catch {
      this.reportAcknowledgementFailure(held.session);
      return;
    }
    void Promise.resolve(result).catch(() => this.reportAcknowledgementFailure(held.session));
  }

  private releaseHeldAcknowledgements(session: string): void {
    const held = this.heldAcknowledgements;
    this.heldAcknowledgements = [];
    for (const record of held) {
      if (record.session === session && session === this.activeSession) this.acknowledge(record);
    }
  }

  private armDrain(): void {
    const watchDrain = this.sink.watchDrain;
    if (this.disposeDrain !== undefined || watchDrain === undefined) return;
    let listening = true;
    let dispose: (() => void) | undefined;
    // One subscription is released as soon as it fires, so a blocked write can never add a second.
    const release = (): void => {
      listening = false;
      dispose?.();
    };
    dispose = watchDrain.call(this.sink, () => {
      if (!listening) return;
      release();
      this.disposeDrain = undefined;
      this.sinkWritable = true;
      if (this.activeSession === undefined) return;
      if (this.pending !== undefined) this.schedule();
      else this.releaseHeldAcknowledgements(this.activeSession);
    });
    // A sink that reports recovery synchronously has already run the listener above, and its
    // disposer only exists now — release it here instead of retaining a dead subscription.
    if (!listening) release();
    else this.disposeDrain = release;
  }

  private flush(): void {
    const session = this.activeSession;
    const record = this.pending;
    if (session === undefined || record === undefined || record.session !== session) return;
    if (!this.sinkWritable) return;

    const now = this.clock.now();
    if (this.lastOutputAt !== undefined && now - this.lastOutputAt < this.minIntervalMs) {
      this.schedule();
      return;
    }

    // A `false` write means THIS frame was accepted and the NEXT must wait, so the frame is released
    // before writing: retaining it here would paint the same pixels twice.
    this.pending = undefined;
    const accepted = this.sink.write(record.frame) !== false;
    this.lastOutputAt = now;
    // A sink that cannot report recovery gets pure interval pacing; believing its backpressure with
    // no drain signal to clear it is how kteam could stall a stream permanently.
    this.sinkWritable = accepted || this.sink.watchDrain === undefined;
    if (!this.sinkWritable) {
      this.armDrain();
      return;
    }
    // Acknowledgements stay outside the capture source's own command queue, and stay held while the
    // sink is blocked: the capture window then stays bounded and the freshest frame wins on recovery.
    this.releaseHeldAcknowledgements(session);
  }

  private schedule(): void {
    if (this.activeSession === undefined || this.pending === undefined) return;
    if (this.timer !== undefined || !this.sinkWritable) return;
    const now = this.clock.now();
    const dueAt = this.lastOutputAt === undefined ? now : this.lastOutputAt + this.minIntervalMs;
    if (dueAt <= now) {
      this.flush();
      return;
    }
    const expectedSession = this.activeSession;
    this.timer = this.clock.schedule(() => {
      this.timer = undefined;
      if (expectedSession !== this.activeSession) return;
      this.flush();
    }, dueAt - now);
  }
}
