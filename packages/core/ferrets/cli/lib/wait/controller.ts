import type { FerretSummary } from '../../../contract/index.ts';
import { SessionCommandError } from '../session/errors.ts';
import { decideWait, type EndedWait, renderWaitOutcome, type WaitNotices, waitExitCode } from './decide.ts';

/** Flags accepted by `fy wait`. */
export interface WaitOptions {
  readonly json?: boolean;
  readonly timeout?: number;
  readonly untilMarker?: string;
  readonly interval?: number;
}

/** What the loop reads of the world; injected so a poll loop is testable without real time passing. */
export interface WaitPorts {
  get(reference: string): Promise<FerretSummary>;
  /** Whether the deliverable named by `--until-marker` exists yet. */
  markerExists(path: string): Promise<boolean>;
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
  /** Classifies a failed read: a lost daemon ends the wait with its own exit code; anything else is the caller's. */
  transport(error: unknown): 'unavailable' | 'unresponsive' | undefined;
}

export interface WaitOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/**
 * How long a wait sleeps between asks when the caller names no `--interval`: soon at first, then less often for as long
 * as nothing about the ferret moves, and soon again once something does. A lead waiting on its helpers for minutes at a
 * time, a dozen of them each asking every second, would keep the daemon answering for seconds yet to come.
 */
const POLL_LADDER_MS: readonly number[] = [1_000, 2_000, 3_000, 5_000];
const pollDelayMs = (rung: number): number => POLL_LADDER_MS[Math.min(rung, POLL_LADDER_MS.length - 1)] as number;

/** Whether the ferret moved between two asks in a way that makes its end nearer. */
const moved = (before: FerretSummary, after: FerretSummary): boolean =>
  before.state !== after.state || before.stateAt !== after.stateAt || before.waiting?.since !== after.waiting?.since;

function positive(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new SessionCommandError(`${flag} must be a positive integer`);
  return value;
}

/**
 * Block until a ferret settles, and report WHICH way it settled. The loop is only a loop: every decision belongs to
 * `decideWait`, and every ending sets an exit code a script can branch on.
 */
export class WaitController {
  constructor(
    private readonly ports: WaitPorts,
    private readonly out: WaitOutput,
    private readonly binaryName: string,
  ) {}

  private finish(reference: string, options: WaitOptions, ferret: FerretSummary | undefined, outcome: EndedWait): void {
    if (ferret !== undefined)
      this.out.success(options.json === true ? JSON.stringify(ferret) : `${reference} is ${ferret.state}`);
    const explanation = renderWaitOutcome(outcome);
    if (explanation !== undefined) this.out.error(`${this.binaryName} wait: ${explanation}`);
    this.out.setExitCode(waitExitCode(outcome));
  }

  async wait(reference: string, options: WaitOptions): Promise<void> {
    const timeout = positive(options.timeout, '--timeout');
    const fixedSeconds = positive(options.interval, '--interval');
    const fixedMs = fixedSeconds === undefined ? undefined : fixedSeconds * 1_000;
    const deadlineMs = timeout === undefined ? undefined : this.ports.nowMs() + timeout * 1_000;
    const passed = (): boolean => deadlineMs !== undefined && this.ports.nowMs() >= deadlineMs;
    let rung = 0;
    let notices: WaitNotices = { missingMarker: false, declaredWait: false };
    let last: FerretSummary | undefined;
    for (;;) {
      if (passed()) {
        this.finish(reference, options, last, { kind: 'timed-out', ...(last === undefined ? {} : { state: last.state }) });
        return;
      }
      let ferret: FerretSummary;
      try {
        ferret = await this.ports.get(reference);
      } catch (error) {
        if (passed()) {
          this.finish(reference, options, last, { kind: 'timed-out', ...(last === undefined ? {} : { state: last.state }) });
          return;
        }
        const failure = this.ports.transport(error);
        if (failure === undefined) throw error;
        this.finish(reference, options, last, {
          kind: 'daemon-unavailable',
          failure,
          detail: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (last !== undefined && moved(last, ferret)) rung = 0;
      last = ferret;
      const decision = decideWait(
        {
          ferret,
          ...(options.untilMarker === undefined
            ? {}
            : { marker: { path: options.untilMarker, present: await this.ports.markerExists(options.untilMarker) } }),
          expired: passed(),
        },
        notices,
      );
      notices = decision.notices;
      if (decision.outcome.kind !== 'keep-waiting') {
        this.finish(reference, options, ferret, decision.outcome);
        return;
      }
      if (decision.outcome.note !== undefined) this.out.error(`${this.binaryName} wait: ${decision.outcome.note}`);
      const intervalMs = fixedMs ?? pollDelayMs(rung);
      rung += 1;
      await this.ports.sleep(Math.min(intervalMs, deadlineMs === undefined ? intervalMs : Math.max(0, deadlineMs - this.ports.nowMs())));
    }
  }
}
