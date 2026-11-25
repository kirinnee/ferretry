/**
 * A native speech host ended on its own (a crash, an out-of-memory kill, a deadline it did not meet) while something was
 * waiting on it. The message is the plain sentence a person may be told; it never holds what was being said or heard.
 */
export class ChildStopped extends Error {
  constructor(sentence: string) {
    super(sentence);
    this.name = 'ChildStopped';
  }
}

/** How many times in a row the native engine may stop before it is given up for the slower one (until Install is run again). */
export const MAX_CONSECUTIVE_STOPS = 3;

/**
 * The count of stops since the engine last answered a call. One of these per engine: a stop is noted by whoever saw the host
 * end, and an answered call clears it, so it is "in a row", not "in all".
 */
export class StopLedger {
  private count = 0;
  private sentence: string | undefined;

  /** Notes one stop; says whether that was the last one allowed. */
  note(sentence: string): boolean {
    this.count += 1;
    this.sentence = sentence;
    return this.count >= MAX_CONSECUTIVE_STOPS;
  }

  clear(): void {
    this.count = 0;
    this.sentence = undefined;
  }

  /** The plain sentence of the latest stop, until a call is answered. */
  get latest(): string | undefined {
    return this.sentence;
  }
}

/** Whether a failure is (or was caused by) a native host that stopped. */
export function wasStopped(error: unknown): boolean {
  return (
    error instanceof ChildStopped ||
    ((error as { cause?: unknown } | null)?.cause !== undefined && wasStopped((error as { cause?: unknown }).cause))
  );
}
