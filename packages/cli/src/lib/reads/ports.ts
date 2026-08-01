import type { IFyApiClient, SessionAttachTarget } from '@ferretry/protocol';

/**
 * The daemon reads the operator commands need, and nothing else.
 *
 * `get` is here because one of these commands is not a read of content at all: `wait` polls the session
 * VIEW until it settles. Keeping them on one narrow port is what lets every controller below be tested
 * against a hand-written double.
 *
 * `attachTarget` is intentionally NOT a field on `SessionView`: it is short-lived process evidence,
 * resolved by the daemon from its own durable registration and fresh tmux observation. `stream` is the
 * daemon's optional-id socket rather than a client-side merge of session journals.
 */
export type IReadsGateway = Pick<
  IFyApiClient,
  'get' | 'attachTarget' | 'snapshot' | 'logs' | 'events' | 'history' | 'stream'
>;

/** The host action behind `fy attach`, separately injected because it inherits the human terminal. */
export interface ITerminalAttacher {
  attach(target: SessionAttachTarget): Promise<number>;
}

/** Terminal output for the operator reads. `success` is stdout; `error` is stderr. */
export interface IReadsIo {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Wall clock and sleep, injected so a poll loop is testable without real time passing. */
export interface IReadsClock {
  nowMs(): number;
  /** Sleep until the interval passes or the caller leaves, whichever happens first. */
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  /** One cancellable deadline whose signal can also abort an in-flight daemon read. */
  startDeadline(milliseconds: number): IReadsDeadline;
}

/** A deadline owns one timer, and cancelling it releases that timer. */
export interface IReadsDeadline {
  readonly signal: AbortSignal;
  cancel(): void;
}

/** Whether the deliverable a `--until-marker` wait is gated on exists yet. */
export interface IMarkerProbe {
  /** Resolves the caller's path against the invocation directory and reports existence. */
  exists(path: string): Promise<boolean>;
  /** The absolute form of the caller's path, for the message that names it. */
  resolve(path: string): string;
}
