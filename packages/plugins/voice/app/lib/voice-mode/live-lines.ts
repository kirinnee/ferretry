/**
 * SPEAKING WHILE THE FERRET WORKS (voice mode V4). A `<voice>` line that is finished mid-turn is handed to the machine's
 * reply voice at once: it plays behind the piece that is playing now and never waits for the turn to end. This is the
 * second channel of the machine's voice; the first (`machine-speaker.ts`) reads a whole finished reply as one reading.
 *
 * THE QUEUE POLICY. Progress lines can arrive faster than they are spoken. When a NEWER line arrives, every line still
 * waiting (nothing of it has been heard) that is only a progress line is dropped: the person would hear stale news after
 * newer news. Three things are never dropped:
 *
 *   - the FIRST line of a turn (the answer that says the ferret heard you),
 *   - the RESULT (the line that arrives once the turn is no longer working), and
 *   - a line whose first sound has already played (it is being said; a drop would cut it off mid-word).
 *
 * The newest line is never dropped by the arrival it caused, so the last thing said is always the latest thing known.
 *
 * Nothing here keeps or logs the words: a waiting line is held as the ids the stream gave it and a kind.
 */
import type { ReplyState } from '../../../contract/index.ts';
import type { ReplyPlayer, SpeechLineEvent, VoiceStreamHandle } from '../stream/voice-stream.ts';

/** What a spoken line is for. `progress` is the only kind a newer line may outdate. */
export type LineKind = 'first' | 'progress' | 'result';

export interface WaitingLine {
  readonly kind: LineKind;
  /** Whether any of its sound has been heard. */
  readonly started: boolean;
}

/** Which of the waiting lines a newer arrival outdates (by index into `waiting`): progress lines nobody has started to hear. */
export const staleProgress = (waiting: readonly WaitingLine[]): readonly number[] =>
  waiting.flatMap((line, index) => (line.kind === 'progress' && !line.started ? [index] : []));

export interface LiveLine {
  readonly text: string;
  readonly kind: LineKind;
}

/** What the voice-mode panel offers the page's reader of live lines. */
export interface LiveSink {
  /** Speaks the line now (behind what is playing). `false`: the machine's voice cannot take it, and nothing was queued. */
  say(line: LiveLine): boolean;
}

export interface LiveLinesDeps {
  /** The open stream, once there is one. */
  readonly stream: () => Pick<VoiceStreamHandle, 'speak' | 'drop' | 'hush'> | undefined;
  /** Where the machine's reply voice is; `undefined` before the stream said. */
  readonly replyState: () => ReplyState | undefined;
  readonly player: Pick<ReplyPlayer, 'remainingMs'>;
  /** Told when the machine's voice starts and stops being heard for live lines. */
  readonly onActive?: (active: boolean) => void;
  /** Runs `tick` every `ms` until the returned function is called. A suite supplies its own clock. */
  readonly every?: (tick: () => void, ms: number) => () => void;
}

export interface LiveLines extends LiveSink {
  /** Feed every `onSpeech` event of the stream here. */
  onSpeech(event: SpeechLineEvent): void;
  /** The person talked over it (barge-in) or left: everything waiting and playing is dropped. */
  hush(): void;
}

const DRAIN_CHECK_MS = 100;

interface Entry {
  readonly kind: LineKind;
  /** The ids the stream gave the line (one unless it was cut to fit a frame). */
  readonly ids: readonly number[];
  readonly open: Set<number>;
  started: boolean;
}

const setIntervalClock = (tick: () => void, ms: number): (() => void) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export function createLiveLines(deps: LiveLinesDeps): LiveLines {
  const every = deps.every ?? setIntervalClock;
  let entries: Entry[] = [];
  let stopWatch: (() => void) | null = null;
  let active = false;

  const settle = (): void => {
    const now = entries.length > 0 || deps.player.remainingMs() > 0;
    if (now === active) return;
    active = now;
    deps.onActive?.(now);
  };
  const watch = (): void => {
    if (stopWatch !== null) return;
    stopWatch = every(() => {
      settle();
      if (!active) {
        stopWatch?.();
        stopWatch = null;
      }
    }, DRAIN_CHECK_MS);
  };

  return {
    say(line) {
      const stream = deps.stream();
      if (stream === undefined || deps.replyState() === 'absent') return false;
      const lines = stream.speak(line.text);
      if (lines.length === 0) return false;
      // The newer line is in; the older ones that only said "still working" are now stale.
      const stale = new Set(staleProgress(entries));
      for (const index of stale) stream.drop(entries[index]?.ids ?? []);
      entries = entries.filter((_, index) => !stale.has(index));
      const ids = lines.map(each => each.id);
      entries.push({ kind: line.kind, ids, open: new Set(ids), started: false });
      settle();
      watch();
      return true;
    },
    onSpeech(event) {
      const entry = entries.find(each => each.ids.includes(event.id));
      if (entry === undefined) return;
      if (event.event === 'started') entry.started = true;
      else {
        entry.open.delete(event.id);
        if (entry.open.size === 0) entries = entries.filter(each => each !== entry);
      }
    },
    hush() {
      if (entries.length === 0 && !active) return;
      entries = [];
      deps.stream()?.hush();
      stopWatch?.();
      stopWatch = null;
      if (active) {
        active = false;
        deps.onActive?.(false);
      }
    },
  };
}
