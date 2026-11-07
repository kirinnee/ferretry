import type { FerretState } from '@ferretry/core-ferrets/contract';
import type { IPackGateway } from './gateway.ts';
import { PackCommandError } from './pack-table.ts';

/**
 * What `fy wait` decides on every poll, as a pure function of what the ferret's result route and its lead's pack
 * table say.
 *
 * WHY THIS IS ITS OWN MODULE. Blocking until a ferret finishes means deciding what happens when it never does, and a
 * wait must not report success for a ferret that ended badly: one that failed, stalled or was stopped exits non-zero,
 * or the script waiting on it carries on as though the work had been done. That is a decision, not an accident of
 * control flow, so it is a total function over the outcome set, with a test per outcome.
 *
 * THE MAPPING from 5.0's four ferret states (starting, working, idle, stopped):
 * - `stopped` with a `signal done` summary: the work was handed back — `settled` (exit 0).
 * - `stopped` without one: it ended without reporting — `ended` (exit 1).
 * - a ferret the lead's pack table marks `needs-you` (parked on a person) and that declared no wait: `needs-attention`
 *   (exit 3). The result route cannot say this, so it is known only when the caller is itself a lead with a table.
 * - everything else keeps waiting, until the caller's own deadline passes (exit 124).
 */

/** What one poll knows. */
export interface WaitState {
  readonly state: FerretState;
  /** The `signal done` message, when it gave one. */
  readonly summary?: string | undefined;
  /** The result route's `finished`: the ferret is over and will report nothing more until it is launched again. */
  readonly finished: boolean;
  /** The lead's pack table marks it as waiting on a person. */
  readonly needsHuman: boolean;
}

/** Everything a poll knows. */
export interface WaitObservation {
  readonly ferret: WaitState;
  /** The deliverable gate, when one was named: whether the file exists as of this poll. */
  readonly marker?: { readonly path: string; readonly present: boolean };
  /** Whether the caller's own deadline has passed. */
  readonly expired: boolean;
}

/**
 * Every way a wait can end, and the one way it does not.
 *
 * Each terminal outcome carries the exit code a script needs to tell them apart. They are deliberately distinct:
 * "the work finished", "the ferret ended", "a human is needed" and "I gave up" are four different things to a caller.
 */
export type WaitOutcome =
  /** The ferret handed its result back, or the deliverable the caller named appeared. */
  | { readonly kind: 'settled'; readonly reason: 'completed' | 'marker' }
  /** The ferret ended without reporting, or ended without ever producing the deliverable. */
  | { readonly kind: 'ended'; readonly state: FerretState; readonly marker?: string }
  /** The ferret is parked on a human and will not move on its own. */
  | { readonly kind: 'needs-attention'; readonly state: FerretState }
  /** The caller's deadline passed while the ferret was still going. */
  | { readonly kind: 'timed-out'; readonly state?: FerretState }
  /** The daemon connection failed, independently of what state the ferret may be in. */
  | {
      readonly kind: 'daemon-unavailable';
      readonly failure: 'unavailable' | 'unresponsive';
      readonly detail: string;
    }
  /** Nothing decided yet. `note` is said ONCE per wait, on stderr, so a long block is never silent. */
  | { readonly kind: 'keep-waiting'; readonly note?: string };

/** The exit code each ended wait reports. */
export function waitExitCode(outcome: Exclude<WaitOutcome, { kind: 'keep-waiting' }>): number {
  switch (outcome.kind) {
    case 'settled':
      return 0;
    // The ferret ended, or ended without the deliverable: a script that reads 0 as "the work is done" must not proceed.
    case 'ended':
      return 1;
    // Distinct from an ending: nothing is broken, but nothing will happen either until a human replies.
    case 'needs-attention':
      return 3;
    case 'timed-out':
      // 124 is what `timeout(1)` uses, so wrappers that already branch on it keep working.
      return 124;
    case 'daemon-unavailable':
      // EX_UNAVAILABLE: the caller can distinguish losing fyd from a ferret that ended unsuccessfully.
      return 69;
  }
}

/** Notes already said during this wait, so an advisory is never repeated on every poll. */
export interface WaitNotices {
  readonly missingMarker: boolean;
}

/** A stopped ferret that handed a result back. */
const reported = (ferret: WaitState): boolean => ferret.state === 'stopped' && ferret.summary !== undefined;

/**
 * The decision for one poll, and the notices that decision consumed.
 *
 * The MARKER branch is deliberately the outer one. When a deliverable is named it is the ground truth: a ferret that
 * reported without the file keeps waiting (bounded by the caller's deadline), because a ferret saying it is done is a
 * claim and the file is evidence. Only a ferret that has ENDED without it can never produce it, which turns that into
 * a failure.
 */
export function decideWait(
  observation: WaitObservation,
  notices: WaitNotices,
): { readonly outcome: WaitOutcome; readonly notices: WaitNotices } {
  const { ferret, marker, expired } = observation;
  const { state } = ferret;

  if (marker !== undefined) {
    if (marker.present) return { outcome: { kind: 'settled', reason: 'marker' }, notices };
    if (state === 'stopped' && !reported(ferret))
      return { outcome: { kind: 'ended', state, marker: marker.path }, notices };
    // A ferret parked on a human can never produce the deliverable on its own, so hand control back rather than
    // blocking until the deadline.
    if (ferret.needsHuman) return { outcome: { kind: 'needs-attention', state }, notices };
    if (expired) return { outcome: { kind: 'timed-out', state }, notices };
    if (reported(ferret) && !notices.missingMarker) {
      return {
        outcome: {
          kind: 'keep-waiting',
          note: `the ferret reported but ${marker.path} is not there yet; still waiting for it`,
        },
        notices: { ...notices, missingMarker: true },
      };
    }
    return { outcome: { kind: 'keep-waiting' }, notices };
  }

  if (reported(ferret)) return { outcome: { kind: 'settled', reason: 'completed' }, notices };
  if (state === 'stopped') return { outcome: { kind: 'ended', state }, notices };
  if (ferret.needsHuman) return { outcome: { kind: 'needs-attention', state }, notices };
  if (expired) return { outcome: { kind: 'timed-out', state }, notices };
  return { outcome: { kind: 'keep-waiting' }, notices };
}

/** How an ended wait is explained on stderr; the caller prefixes the command name. */
export function renderWaitOutcome(outcome: Exclude<WaitOutcome, { kind: 'keep-waiting' }>): string | undefined {
  switch (outcome.kind) {
    case 'settled':
      return undefined;
    case 'ended':
      return outcome.marker === undefined
        ? `the ferret ended (${outcome.state}) without reporting a result`
        : `the ferret is ${outcome.state} and ${outcome.marker} never appeared`;
    case 'needs-attention':
      return `the ferret is ${outcome.state} and needs a human before it can go further`;
    case 'timed-out':
      return outcome.state === undefined
        ? 'timed out before the daemon returned a ferret state'
        : `gave up while the ferret was still ${outcome.state}`;
    case 'daemon-unavailable':
      return `the daemon became ${outcome.failure}: ${outcome.detail}`;
  }
}

// ─── the poll loop ───────────────────────────────────────────────────────────────────────────────────────────────

/** Flags accepted by `fy wait`. */
export interface WaitOptions {
  readonly json?: boolean;
  readonly timeout?: number;
  readonly untilMarker?: string;
  readonly interval?: number;
  /** Leave a ferret that is still running once its result is collected; by default it is stopped. */
  readonly keep?: boolean;
}

/** Terminal output for `wait`: stdout is the state channel, stderr the outcome channel. */
export interface IWaitIo {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Wall clock and sleep, injected so a poll loop is testable without real time passing. */
export interface IWaitClock {
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
}

/** Whether the deliverable a `--until-marker` wait is gated on exists yet. */
export interface IMarkerProbe {
  /** Resolves the caller's path against the invocation directory and reports existence. */
  exists(path: string): Promise<boolean>;
  /** The absolute form of the caller's path, for the message that names it. */
  resolve(path: string): string;
}

/**
 * How long a wait sleeps between asks when the caller names no `--interval`: soon at first, then less often for as long
 * as nothing about the ferret moves, and soon again once something does. A lead waits on its helpers for minutes at a
 * time, and a dozen of them each asking every second kept the daemon building views nobody was going to act on yet.
 */
const WAIT_POLL_LADDER_MS: readonly number[] = [1_000, 2_000, 3_000, 5_000];

/** The sleep before the next ask: the rung reached, or the last rung once the ladder runs out. */
const waitPollDelayMs = (rung: number): number =>
  WAIT_POLL_LADDER_MS[Math.min(rung, WAIT_POLL_LADDER_MS.length - 1)] as number;

/** A caller-supplied number that must be a whole positive one. */
function positive(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new PackCommandError(`${flag} must be a positive integer`);
  return value;
}

/** How a thrown daemon failure reads: a refusal carries a status; a lost connection does not. */
function transportFailure(error: unknown): { failure: 'unavailable' | 'unresponsive'; detail: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  if (typeof (error as { status?: unknown }).status === 'number') return undefined;
  return {
    failure: (error as { timedOut?: unknown }).timedOut === true ? 'unresponsive' : 'unavailable',
    detail: error.message,
  };
}

const movedBetween = (before: WaitState, after: WaitState): boolean =>
  before.state !== after.state || before.needsHuman !== after.needsHuman || before.finished !== after.finished;

export class WaitController {
  constructor(
    private readonly gateway: Pick<IPackGateway, 'result' | 'table' | 'stop'>,
    private readonly out: IWaitIo,
    private readonly clock: IWaitClock,
    private readonly marker: IMarkerProbe | undefined,
    /** The shipped command name, which prefixes every stderr note so it names a command that exists. */
    private readonly binaryName: string,
    /** The ferret this runs inside, whose pack table says whether the one waited on needs a person. */
    private readonly lead: string | undefined,
  ) {}

  /** One look: the ferret's result, and whether its lead's table says it needs a person. */
  private async observe(id: string): Promise<{ readonly ferret: WaitState; readonly summary: string | undefined }> {
    const result = await this.gateway.result(id);
    const table = this.lead === undefined ? undefined : await this.gateway.table(this.lead).catch(() => undefined);
    const needsHuman = table?.rows.find(row => row.id === id)?.state === 'needs-you';
    return {
      ferret: { state: result.state, finished: result.finished, summary: result.summary, needsHuman },
      summary: result.summary,
    };
  }

  /**
   * Reports how a wait ended. A SETTLED wait also hands back the ferret's result — its `signal done` message — and
   * stops a ferret still running once that result is collected (a `--until-marker` wait on one that has not
   * reported), unless the caller said `--keep` (docs/pack-mode.md).
   */
  private async finish(
    id: string,
    options: WaitOptions,
    last: WaitState | undefined,
    summary: string | undefined,
    outcome: Exclude<WaitOutcome, { kind: 'keep-waiting' }>,
  ): Promise<void> {
    if (last !== undefined) {
      this.out.success(
        options.json === true
          ? JSON.stringify({ id, state: last.state, finished: last.finished, ...(summary === undefined ? {} : { result: summary }) })
          : `${id} is ${last.state}${summary === undefined ? '' : `\n\n${summary}`}`,
      );
    }
    if (outcome.kind === 'settled' && last !== undefined && !last.finished && options.keep !== true) {
      await this.gateway.stop(id, 'its result was collected').catch(() => undefined);
      this.out.error(`${this.binaryName} wait: stopped ${id} now its result is collected (--keep leaves it running)`);
    }
    const explanation = renderWaitOutcome(outcome);
    if (explanation !== undefined) this.out.error(`${this.binaryName} wait: ${explanation}`);
    this.out.setExitCode(waitExitCode(outcome));
  }

  /**
   * Block until the ferret settles, and report WHICH way it settled.
   *
   * The loop is only a loop: every decision belongs to `decideWait`, and every ending sets an exit code a script can
   * branch on. A `--until-marker` wait treats the file as the ground truth over the ferret's own claim of being done,
   * which is what makes it a deliverable gate rather than a second way of reading the state.
   */
  async wait(id: string, options: WaitOptions): Promise<void> {
    const timeout = positive(options.timeout, '--timeout');
    const fixedSeconds = positive(options.interval, '--interval');
    const fixedMs = fixedSeconds === undefined ? undefined : fixedSeconds * 1_000;
    if (options.untilMarker !== undefined && this.marker === undefined)
      throw new PackCommandError('--until-marker needs a terminal that can look for files; this one cannot', 2);
    // Which rung of the ladder the next sleep is on; back to the first whenever the ferret moved.
    let rung = 0;
    const markerPath = options.untilMarker === undefined ? undefined : this.marker?.resolve(options.untilMarker);
    const deadlineMs = timeout === undefined ? undefined : this.clock.nowMs() + timeout * 1_000;
    const deadlinePassed = (): boolean => deadlineMs !== undefined && this.clock.nowMs() >= deadlineMs;
    let notices: WaitNotices = { missingMarker: false };
    let last: { readonly ferret: WaitState; readonly summary: string | undefined } | undefined;

    for (;;) {
      if (deadlinePassed()) {
        await this.finish(id, options, last?.ferret, last?.summary, {
          kind: 'timed-out',
          ...(last === undefined ? {} : { state: last.ferret.state }),
        });
        return;
      }
      let seen: NonNullable<typeof last>;
      try {
        seen = await this.observe(id);
      } catch (error) {
        const lost = transportFailure(error);
        if (lost === undefined) throw error;
        if (deadlinePassed()) {
          await this.finish(id, options, last?.ferret, last?.summary, {
            kind: 'timed-out',
            ...(last === undefined ? {} : { state: last.ferret.state }),
          });
          return;
        }
        await this.finish(id, options, last?.ferret, last?.summary, { kind: 'daemon-unavailable', ...lost });
        return;
      }
      if (last !== undefined && movedBetween(last.ferret, seen.ferret)) rung = 0;
      last = seen;
      const decision = decideWait(
        {
          ferret: seen.ferret,
          ...(markerPath === undefined || this.marker === undefined
            ? {}
            : { marker: { path: markerPath, present: await this.marker.exists(markerPath) } }),
          expired: deadlinePassed(),
        },
        notices,
      );
      notices = decision.notices;
      if (decision.outcome.kind === 'keep-waiting') {
        if (decision.outcome.note !== undefined) this.out.error(`${this.binaryName} wait: ${decision.outcome.note}`);
        const intervalMs = fixedMs ?? waitPollDelayMs(rung);
        rung += 1;
        const remainingMs = deadlineMs === undefined ? intervalMs : Math.max(0, deadlineMs - this.clock.nowMs());
        await this.clock.sleep(Math.min(intervalMs, remainingMs));
        continue;
      }
      await this.finish(id, options, seen.ferret, seen.summary, decision.outcome);
      return;
    }
  }
}
