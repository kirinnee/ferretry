import type { TranscriptFileEvents } from './file-transcript-changes.ts';

/**
 * How often a followed transcript is asked whether it was written. Never faster than today's live sample (500 ms): the
 * kernel offers no file watch on a root, so the stream asks (`FileTranscriptChanges` compares each answer to the stamp it
 * took before subscribing, so a quiet file says nothing).
 */
export const TRANSCRIPT_POLL_MS = 1_000;

/**
 * The file-event hub `FileTranscriptChanges` listens through, by polling (U5): every subscription is one timer on the
 * kernel's clock that tells its listener "look at this path now" each {@link TRANSCRIPT_POLL_MS}, until it is closed.
 * It reports nothing by itself and holds no path, handle or watch: the listener stats, and decides whether it moved.
 */
export class PolledTranscriptEvents implements TranscriptFileEvents {
  constructor(
    /** Runs `tick` every `intervalMs` until the answer is called (`kernel.clock.every`). */
    private readonly every: (intervalMs: number, tick: () => void) => () => void,
  ) {}

  subscribe(path: string, listener: (path: string) => void): { close(): void } {
    let stop: (() => void) | undefined = this.every(TRANSCRIPT_POLL_MS, () => listener(path));
    return {
      close: () => {
        stop?.();
        stop = undefined;
      },
    };
  }
}
