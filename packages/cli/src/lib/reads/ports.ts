import type { IFyApiClient } from '@ferretry/protocol';

/**
 * The daemon reads the operator commands need, and nothing else.
 *
 * `get` is here because one of these commands is not a read of content at all: `wait` polls the session
 * VIEW until it settles. Keeping them on one narrow port is what lets every controller below be tested
 * against a hand-written double.
 *
 * `fy attach` is ABSENT from this domain and from the CLI, and the blocker is on this port's own subject:
 * a `SessionView` carries no terminal address. Legacy `kteam attach` read `view.config.tmuxSession` and
 * handed it to `tmux attach-session`; `SessionConfigSchema` has no such member, so no client can name the
 * pane to attach to. Guessing one from the session id would address whatever pane happened to answer to
 * that name — including another daemon's — which is precisely the failure this unit must not ship.
 */
export type IReadsGateway = Pick<IFyApiClient, 'get' | 'snapshot' | 'logs' | 'events' | 'history'>;

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
