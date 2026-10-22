/** What a step knows up front about how long it will take, for a countdown rather than a stopwatch. */
export interface ProgressStepOptions {
  readonly expectedSeconds?: number;
}

/**
 * Live status for a command that takes long enough to look stuck.
 *
 * One step is live at a time. `start` while another is live completes that one first, so a controller
 * names the phases it moves through and never pairs a `succeed` with every `start`. Nothing here
 * writes to stdout: a progress line is a diagnostic, and machine-readable output must stay whole.
 */
export interface IProgress {
  /** Begin a named step; a step still live is completed first. */
  start(label: string, options?: ProgressStepOptions): void;
  /** Replace the live detail of the current step ("48/120 MB"). Ignored when no step is live. */
  detail(text: string): void;
  /** Complete the live step, with `text` as its line when it is more than the step's own label. */
  succeed(text?: string): void;
  /** End the live step as failed, with `text` as its line when it is more than the step's own label. */
  fail(text?: string): void;
  /** Lift the live line off the terminal so the caller can print above it; the next tick draws it again. */
  pause(): void;
  /** Abandon the live step without a line and restore the terminal. Safe to call at any time, and twice. */
  stop(): void;
}

/** Progress that says nothing: for callers that did not ask for it, and tests about something else. */
export const NO_PROGRESS: IProgress = {
  start: () => undefined,
  detail: () => undefined,
  succeed: () => undefined,
  fail: () => undefined,
  pause: () => undefined,
  stop: () => undefined,
};
