/**
 * What the send watch needs of the transcript reader: the ferret facts a read is keyed by, a window onto the
 * transcript file, and the drain that walks a window. The reader itself (resolving a harness's file, parsing it)
 * is the reader's (`../reader`); this is the narrow port the watch stands on.
 */
import type {
  TranscriptBatch,
  TranscriptHarness,
  TranscriptWindow,
  TranscriptWindowStart,
} from './transcript-types.ts';

/** The ferret facts a transcript read needs. */
export interface TranscriptTarget {
  readonly sessionId: string;
  readonly harness: TranscriptHarness;
}

export interface SessionTranscriptReader {
  /** The transcript file proved to be this ferret's, or nothing. */
  file(target: TranscriptTarget): Promise<string | undefined>;
  window(target: TranscriptTarget, start: TranscriptWindowStart): Promise<TranscriptWindow | undefined>;
}

/** The most steps one drain walks before it gives up and says it did not reach the end. */
const WINDOW_STEP_LIMIT = 64;

/**
 * Every step of `window` until it reaches the end of the file, handed to `visit` one at a time and
 * never collected: the visitor keeps what it needs. Answers whether the end was reached.
 */
export async function drainTranscriptWindow(
  window: TranscriptWindow,
  visit: (batch: TranscriptBatch) => void,
): Promise<boolean> {
  for (let step = 0; step < WINDOW_STEP_LIMIT; step += 1) {
    const { batch, more } = await window.next();
    if (batch !== undefined) visit(batch);
    if (!more) return true;
  }
  return false;
}
