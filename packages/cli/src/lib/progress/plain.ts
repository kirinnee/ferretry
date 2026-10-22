import type { IProgress } from './ports.ts';

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
