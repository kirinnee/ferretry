import { FyTransportError } from '@ferretry/protocol/client';
import { SessionCommandError } from '../session/errors.ts';
import type { IMarkerProbe, IReadsClock, IReadsGateway, IReadsIo, ITerminalAttacher } from './ports.ts';
import { renderEvent, renderFleetStreamIdle, renderStreamIdle } from './render.ts';
import { decideWait, renderWaitOutcome, type WaitNotices, type WaitOutcome, waitExitCode } from './wait.ts';

/**
 * The operator read commands: how a human watches a session that is already running.
 *
 * `attach`, `snapshot`, `logs` and `events` are single operations over routes the daemon now mounts.
 * `stream` is a long-lived socket and `wait` is a polling loop; each carries a rule the legacy
 * command did not:
 *
 * - A stream is a long-lived read. It must be cancellable, it must not hold anything after the caller
 *   goes away, and it must not stall silently. The AbortSignal closes its socket, while daemon idle
 *   frames prove a quiet feed is still live. Silence is REPORTED rather than implied.
 * - A wait must be able to fail, and its outcomes are decided by `decideWait` rather than by the shape
 *   of this loop. See that module for why every terminal status used to exit 0.
 */

/** Flags accepted by `fy snapshot`. */
export interface SnapshotOptions {
  readonly json?: boolean;
}

/** Flags accepted by `fy logs`. */
export interface LogsOptions {
  readonly turn?: number;
}

/** Flags accepted by `fy events` and its `fy view` alias. */
export interface EventsOptions {
  readonly after?: number;
  readonly limit?: number;
  readonly json?: boolean;
}

/** Flags accepted by `fy stream`. */
export interface StreamOptions {
  readonly after?: number;
  readonly json?: boolean;
}

/** Flags accepted by `fy wait`. */
export interface WaitOptions {
  readonly json?: boolean;
  readonly timeout?: number;
  readonly untilMarker?: string;
  readonly interval?: number;
}

/** How often a wait asks the daemon again, when the caller names nothing. */
const DEFAULT_POLL_SECONDS = 1;

/** A caller-supplied number that must be a whole positive one. */
function positive(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new SessionCommandError(`${flag} must be a positive integer`);
  return value;
}

/** A caller-supplied cursor, which may legitimately be zero. */
function cursor(value: number | undefined, flag: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new SessionCommandError(`${flag} must be a non-negative integer`);
  return value;
}

export class ReadsController {
  constructor(
    private readonly gateway: IReadsGateway,
    private readonly out: IReadsIo,
    private readonly clock: IReadsClock,
    private readonly marker: IMarkerProbe,
    private readonly attacher: ITerminalAttacher,
  ) {}

  /** Attach only after both daemon and client proved the complete tmux process incarnation. */
  async attach(sessionId: string): Promise<void> {
    const target = await this.gateway.attachTarget(sessionId);
    this.out.setExitCode(await this.attacher.attach(target));
  }

  /** The session's live screen. A dead pane is a daemon refusal, and it surfaces as one. */
  async snapshot(sessionId: string, options: SnapshotOptions): Promise<void> {
    const screen = await this.gateway.snapshot(sessionId);
    this.out.success(options.json === true ? JSON.stringify({ sessionId, snapshot: screen }) : screen);
  }

  /**
   * The session's transcript tail.
   *
   * `--turn` reaches the daemon, which returns only an explicitly bounded normalized transcript turn.
   */
  async logs(sessionId: string, options: LogsOptions): Promise<void> {
    this.out.success(await this.gateway.logs(sessionId, options.turn));
  }

  /** One page — or every page — of the session's durable history. */
  async events(sessionId: string, options: EventsOptions): Promise<void> {
    const after = cursor(options.after, '--after');
    const limit = positive(options.limit, '--limit');
    const events = await this.gateway.history(sessionId, after, limit);
    if (options.json === true) {
      for (const event of events) this.out.success(JSON.stringify(event));
      return;
    }
    for (const event of events) this.out.success(renderEvent(event));
  }

  /**
   * Follow one session, or this daemon's whole fleet, over the mounted event socket.
   *
   * Sequences remain per-session even in the fleet form, so every session owns its own cursor. A
   * fleet socket starts with the daemon's bounded recent tail and therefore refuses a non-zero
   * `--after`; only a scoped stream can honestly resume one numeric cursor.
   */
  async stream(sessionId: string | undefined, options: StreamOptions, signal: AbortSignal): Promise<void> {
    const after = cursor(options.after, '--after');
    if (sessionId === undefined && after !== 0)
      throw new SessionCommandError('a fleet stream has no global cursor; omit --after or name one session');
    if (signal.aborted) return;
    const positions = new Map<string, number>();
    if (sessionId !== undefined) positions.set(sessionId, after);
    await this.gateway.stream(
      sessionId,
      after,
      event => {
        if (sessionId !== undefined && event.sessionId !== sessionId)
          throw new Error(`fyd returned an event for ${event.sessionId} while following ${sessionId}`);
        const previous = positions.get(event.sessionId) ?? after;
        if (event.sequence <= previous)
          throw new Error(
            `fyd returned a non-advancing event sequence #${event.sequence} for ${event.sessionId} after #${previous}`,
          );
        positions.set(event.sessionId, event.sequence);
        this.out.success(options.json === true ? JSON.stringify(event) : renderEvent(event));
      },
      signal,
      idle => {
        if (sessionId === undefined) {
          if (idle.scope.kind !== 'fleet') throw new Error('fyd returned a session idle proof for a fleet stream');
          this.out.error(renderFleetStreamIdle(idle.scope.followedSessions, idle.idleSeconds));
          return;
        }
        const position = positions.get(sessionId) ?? after;
        if (idle.scope.kind !== 'session' || idle.scope.sessionId !== sessionId || idle.scope.after !== position)
          throw new Error('fyd returned an idle proof that contradicted the followed session cursor');
        this.out.error(renderStreamIdle(sessionId, position, idle.idleSeconds));
      },
    );
  }

  /** End one wait, preserving stdout as a state channel and stderr as an outcome channel. */
  private finishWait(
    sessionId: string,
    json: boolean,
    view: Awaited<ReturnType<IReadsGateway['get']>> | undefined,
    outcome: Exclude<WaitOutcome, { kind: 'keep-waiting' }>,
  ): void {
    if (view !== undefined)
      this.out.success(json ? JSON.stringify(view.state) : `${sessionId} is ${view.state.status}`);
    const explanation = renderWaitOutcome(outcome);
    if (explanation !== undefined) this.out.error(explanation);
    this.out.setExitCode(waitExitCode(outcome));
  }

  /**
   * Block until the session settles, and report WHICH way it settled.
   *
   * The loop is only a loop: every decision belongs to `decideWait`, and every ending sets an exit code
   * a script can branch on. A `--until-marker` wait treats the file as the ground truth over the
   * session's own claim of completion, which is what makes it a deliverable gate rather than a second
   * way of reading the status.
   */
  async wait(sessionId: string, options: WaitOptions): Promise<void> {
    const timeout = positive(options.timeout, '--timeout');
    const intervalMs = (positive(options.interval, '--interval') ?? DEFAULT_POLL_SECONDS) * 1_000;
    const markerPath = options.untilMarker === undefined ? undefined : this.marker.resolve(options.untilMarker);
    const deadlineMs = timeout === undefined ? undefined : this.clock.nowMs() + timeout * 1_000;
    const deadline = timeout === undefined ? undefined : this.clock.startDeadline(timeout * 1_000);
    const deadlinePassed = (): boolean =>
      deadline?.signal.aborted === true || (deadlineMs !== undefined && this.clock.nowMs() >= deadlineMs);
    let notices: WaitNotices = { missingMarker: false, declaredWait: false };
    let lastView: Awaited<ReturnType<IReadsGateway['get']>> | undefined;

    try {
      for (;;) {
        if (deadlinePassed()) {
          this.finishWait(sessionId, options.json === true, lastView, {
            kind: 'timed-out',
            ...(lastView === undefined ? {} : { status: lastView.state.status }),
          });
          return;
        }

        let view: Awaited<ReturnType<IReadsGateway['get']>>;
        try {
          view = await this.gateway.get(sessionId, deadline?.signal);
        } catch (error) {
          if (deadlinePassed()) {
            this.finishWait(sessionId, options.json === true, lastView, {
              kind: 'timed-out',
              ...(lastView === undefined ? {} : { status: lastView.state.status }),
            });
            return;
          }
          if (error instanceof FyTransportError) {
            this.finishWait(sessionId, options.json === true, lastView, {
              kind: 'daemon-unavailable',
              failure: error.timedOut ? 'unresponsive' : 'unavailable',
              detail: error.message,
            });
            return;
          }
          throw error;
        }
        lastView = view;
        const decision = decideWait(
          {
            state: view.state,
            ...(markerPath === undefined
              ? {}
              : { marker: { path: markerPath, present: await this.marker.exists(markerPath) } }),
            expired: deadlinePassed(),
          },
          notices,
        );
        notices = decision.notices;
        if (decision.outcome.kind === 'keep-waiting') {
          if (decision.outcome.note !== undefined) this.out.error(decision.outcome.note);
          const remainingMs = deadlineMs === undefined ? intervalMs : Math.max(0, deadlineMs - this.clock.nowMs());
          await this.clock.sleep(Math.min(intervalMs, remainingMs), deadline?.signal);
          continue;
        }
        this.finishWait(sessionId, options.json === true, view, decision.outcome);
        return;
      }
    } finally {
      deadline?.cancel();
    }
  }
}
