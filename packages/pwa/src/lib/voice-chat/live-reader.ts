/**
 * LIVE'S READER: what Live uses to say a finished turn out loud. It is the adapter between the loop's
 * `ReaderPort` and the page's ONE read-aloud controller (`read-aloud.ts`), so a reading started by Live
 * is the same reading a Read aloud button starts: the same voice, speed, length cap and sentence captions
 * in the chat, and never two voices at once.
 *
 * WHAT IT READS comes from the conversation the page already holds (`LiveReadingSource`), through the
 * pure picker (`reply-picker.ts`): ONLY the last message of the turn (or every one, if the person chose
 * that), "Done. No message." for a silent turn, or the question and its options when the ferret is
 * waiting. `mark()` remembers the rows the page held when a message went, so a turn with no text can
 * never fall back to the previous turn's reply. Nothing here logs, stores or sends the words.
 *
 * TEXT SETTLES FIRST. The daemon says the turn is over a moment before the last record always shows on
 * the page, so a reading waits until the conversation has been quiet for {@link QUIET_MS} (at most
 * {@link MAX_WAIT_MS}) before it picks. Stopping during that wait ends it at once, silently.
 *
 * ONE END. `read` calls `onEnd` exactly once: when speech finished, failed, found no voice that stays on
 * the device, or was stopped (by `stop()`, a newer `read`, or another reading taking the voice).
 * Total: nothing here throws.
 */

import { type LiveVoiceSettings, readOptionsOf } from './live-settings.ts';
import type { ClockPort, ReadEnd, ReaderPort, ReadWhat } from './ports.ts';
import type { ReadAloudController, ReadAloudState } from './read-aloud.ts';
import { type PickerRow, pickQuestion, pickReply, type QuestionLike } from './reply-picker.ts';

/** The conversation, as Live reads it. */
export interface LiveReadingSource {
  /** The rows on screen now, oldest first. */
  rows(): readonly PickerRow[];
  /** The question or prompt a `needs-input` turn waits on, if there is one. */
  question(): QuestionLike | null | undefined;
}

export interface LiveReaderDeps {
  readonly controller: ReadAloudController;
  readonly source: LiveReadingSource;
  /** Read afresh at each reading, so a voice or speed changed mid-Live applies to the next reply. */
  readonly settings: () => LiveVoiceSettings;
  readonly clock: ClockPort;
}

/** The conversation must hold still this long before the reply is picked. */
export const QUIET_MS = 500;
/** ...but a conversation that never stops changing is read after this long anyway. */
export const MAX_WAIT_MS = 3_000;
const POLL_MS = 100;

const signatureOf = (source: LiveReadingSource): string => {
  try {
    const rows = source.rows();
    const last = rows.at(-1);
    const question = source.question();
    return `${rows.length}|${last?.id ?? ''}|${last?.text.length ?? 0}|${question === null || question === undefined ? 0 : 1}`;
  } catch {
    return '';
  }
};

const endOf = (state: ReadAloudState, key: string): ReadEnd | null => {
  if (state.key !== key) return 'stopped';
  switch (state.status) {
    case 'reading':
      return null;
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'finished';
  }
};

export function createLiveReader(deps: LiveReaderDeps): ReaderPort {
  const { controller, source, clock } = deps;
  let known: readonly string[] | undefined;
  /** Ends whatever is in progress (a wait or a reading), exactly once. Null when idle. */
  let cancel: ((end: ReadEnd) => void) | null = null;

  const settingsNow = (): LiveVoiceSettings => deps.settings();

  const pick = (what: ReadWhat) =>
    what === 'question'
      ? pickQuestion(source.question())
      : pickReply(source.rows(), { startedAt: null, knownIds: known }, settingsNow().whatToRead);

  return {
    supported: controller.supported,
    unlock: () => controller.unlock(),
    mark: () => {
      try {
        known = source.rows().map(row => row.id);
      } catch {
        known = undefined;
      }
    },
    read: (what, onEnd) => {
      cancel?.('stopped');
      let over = false;
      let stopWaiting: (() => void) | null = null;
      let unsubscribe: (() => void) | null = null;
      const finish = (end: ReadEnd): void => {
        if (over) return;
        over = true;
        stopWaiting?.();
        unsubscribe?.();
        if (cancel === finish) cancel = null;
        onEnd(end);
      };
      cancel = end => {
        if (over) return;
        if (unsubscribe !== null) controller.stop();
        finish(end);
      };

      const speak = (): void => {
        if (over) return;
        let key = '';
        try {
          const chosen = pick(what);
          key = chosen.key;
          unsubscribe = controller.subscribe(() => {
            const end = endOf(controller.getState(), key);
            if (end !== null) finish(end);
          });
          controller.read(chosen.key, chosen.markdown, readOptionsOf(settingsNow()));
          const end = endOf(controller.getState(), key);
          if (end !== null) finish(end);
        } catch {
          finish('failed');
        }
      };

      // Wait for the conversation to hold still, then pick.
      const startedAt = clock.now();
      let seen = signatureOf(source);
      let changedAt = startedAt;
      const poll = (): void => {
        stopWaiting = null;
        if (over) return;
        const now = clock.now();
        const signature = signatureOf(source);
        if (signature !== seen) {
          seen = signature;
          changedAt = now;
        }
        if (now - changedAt >= QUIET_MS || now - startedAt >= MAX_WAIT_MS) speak();
        else stopWaiting = clock.after(POLL_MS, poll);
      };
      stopWaiting = clock.after(POLL_MS, poll);
    },
    stop: () => cancel?.('stopped'),
  };
}
