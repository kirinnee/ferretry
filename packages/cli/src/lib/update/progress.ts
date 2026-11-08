/** The slice of the fy shell's progress line the update draws with (copied from today's `lib/progress`). */
/** `3.4s` under ten seconds, `42s` under a minute, then `2m05s` — enough precision to see it is moving. */
export function formatElapsed(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'gu');

/** A tool's output line with escape sequences and control characters removed, so it is safe to print as detail. */
export function plainLine(text: string): string {
  return text
    .replaceAll(ANSI, '')
    .replaceAll('\t', ' ')
    .replaceAll(/\p{Cc}/gu, '')
    .trim();
}

/** Bytes in the unit a download reads in: whole megabytes while large, one decimal while small. */
function formatMegabytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return megabytes < 10 ? megabytes.toFixed(1) : String(Math.round(megabytes));
}

/** `48/120 MB`, from two byte counts. */
export function formatByteProgress(done: number, expected: number): string {
  return `${formatMegabytes(done)}/${formatMegabytes(expected)} MB`;
}

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

/**
 * Progress for a terminal that cannot redraw — a pipe, a CI log, `--json`: one plain line when a step
 * begins, a line when one fails, and nothing else. No spinner frames, no escape sequences, no timing
 * that would make two runs of the same command differ.
 */
export class PlainProgress implements IProgress {
  #live: string | undefined;

  constructor(private readonly write: (line: string) => void) {}

  start(label: string): void {
    this.#live = label;
    this.write(`- ${label}`);
  }

  detail(): void {}

  succeed(text?: string): void {
    if (text !== undefined) this.write(`✔ ${text}`);
    this.#live = undefined;
  }

  fail(text?: string): void {
    const line = text ?? (this.#live === undefined ? undefined : `${this.#live} failed`);
    if (line !== undefined) this.write(`✖ ${line}`);
    this.#live = undefined;
  }

  pause(): void {}

  stop(): void {
    this.#live = undefined;
  }
}
