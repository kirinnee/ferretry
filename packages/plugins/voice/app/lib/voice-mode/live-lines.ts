/**
 * SPEAKING WHILE THE FERRET WORKS (voice mode V4). A `<voice>` line that is finished mid-turn is handed to the machine's
 * reply voice at once: it plays behind the piece that is playing now and never waits for the turn to end. This is the
 * second channel of the machine's voice; the first (`machine-speaker.ts`) reads a whole finished reply as one reading.
 *
 * THE QUEUE POLICY. Progress lines can arrive faster than they are spoken. A line is dropped only when it is KNOWN to be
 * progress (the reader of the rows says so: the ferret went on to use a tool after it, so it was not the end of the turn),
 * nothing of it has been heard, and a NEWER line is waiting behind it: the person would hear stale news after newer news.
 * When unsure, a line is kept. Three things are never dropped:
 *
 *   - the FIRST line of a turn (the answer that says the ferret heard you),
 *   - any line nobody has said is progress (the result, and the parts of it, are never told apart from it by arrival), and
 *   - a line whose first sound has already played (it is being said; a drop would cut it off mid-word).
 *
 * The newest line is never dropped, so the last thing said is always the latest thing known.
 *
 * WHAT BECAME OF EACH LINE is told to whoever handed it over (`ended`): `played` (every piece finished playing), `dropped`
 * (outdated on purpose: it is never read again) or `unplayed` (a piece failed to be made, the person talked over it, or the
 * stream went away: the end-of-turn reading says it). A line the voice refuses at the door (`say` is false) was never queued.
 *
 * Nothing here keeps or logs the words beyond the line waiting: a waiting line is held as its words (to name it when the
 * reader says it is progress), the ids the stream gave it and a kind.
 */
import type { ReplyState } from '../../../contract/index.ts';
import type { ReplyPlayer, SpeechLineEvent, VoiceStreamHandle } from '../stream/voice-stream.ts';

/** What a spoken line is for: the `first` of a turn is never outdated; any other line is outdated only once it is known to be progress. */
export type LineKind = 'first' | 'line';

/** What became of a line that was handed to the voice. */
export type LineOutcome = 'played' | 'dropped' | 'unplayed';

export interface WaitingLine {
  readonly kind: LineKind;
  /** The reader said the ferret went on working after this line, so it is not the end of the turn. */
  readonly progress: boolean;
  /** Whether any of its sound has been heard. */
  readonly started: boolean;
}

/**
 * Which of the waiting lines a newer one outdates (by index into `waiting`, oldest first): lines KNOWN to be progress, that are
 * not the first of the turn, that nobody has started to hear, and that have another line behind them.
 */
export const staleProgress = (waiting: readonly WaitingLine[]): readonly number[] =>
  waiting.flatMap((line, index) =>
    line.progress && line.kind !== 'first' && !line.started && index < waiting.length - 1 ? [index] : [],
  );

export interface LiveLine {
  readonly text: string;
  readonly kind: LineKind;
}

/** What the voice-mode panel offers the page's reader of live lines. */
export interface LiveSink {
  /**
   * Speaks the line now (behind what is playing). `false`: the machine's voice cannot take it, and nothing was queued. `ended`
   * is told what became of the line, once, when it is settled.
   */
  say(line: LiveLine, ended: (outcome: LineOutcome) => void): boolean;
  /** These lines (by their words) are known to be progress: any of them still waiting behind a newer line is dropped. */
  outdate(texts: readonly string[]): void;
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
  /** The person talked over it (barge-in): everything waiting and playing is dropped, and what was not played is told as such. */
  hush(): void;
  /** The panel is going away: nothing is watched any more, and whatever was not played is told as such. */
  dispose(): void;
}

const DRAIN_CHECK_MS = 100;

interface Entry {
  readonly kind: LineKind;
  readonly text: string;
  readonly ended: (outcome: LineOutcome) => void;
  /** Known to be progress (the ferret went on working after it). */
  progress: boolean;
  /** A piece of it could not be made. */
  failed: boolean;
  /** Every piece has been handed to the player; it is PLAYED once the player has no sound left. */
  done: boolean;
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
  /** A line is played when every piece has been handed over AND the player has finished with what it was given. */
  const flush = (): void => {
    if (deps.player.remainingMs() > 0) return;
    const finished = entries.filter(entry => entry.done);
    if (finished.length === 0) return;
    entries = entries.filter(entry => !entry.done);
    for (const entry of finished) entry.ended('played');
  };
  const watch = (): void => {
    if (stopWatch !== null) return;
    stopWatch = every(() => {
      flush();
      settle();
      if (!active) {
        stopWatch?.();
        stopWatch = null;
      }
    }, DRAIN_CHECK_MS);
  };

  /** The lines the newest one outdates are taken back from the machine and told as dropped. */
  const prune = (): void => {
    const stale = new Set(staleProgress(entries));
    if (stale.size === 0) return;
    const stream = deps.stream();
    const gone = entries.filter((_, index) => stale.has(index));
    entries = entries.filter((_, index) => !stale.has(index));
    for (const entry of gone) {
      stream?.drop(entry.ids);
      entry.ended('dropped');
    }
  };
  /** Everything waiting or playing is over without having been played (or dropped on purpose). */
  const abandon = (): void => {
    const left = entries;
    entries = [];
    stopWatch?.();
    stopWatch = null;
    for (const entry of left) entry.ended('unplayed');
    if (active) {
      active = false;
      deps.onActive?.(false);
    }
  };

  return {
    say(line, ended) {
      const stream = deps.stream();
      if (stream === undefined || deps.replyState() === 'absent') return false;
      const lines = stream.speak(line.text);
      if (lines.length === 0) return false;
      const ids = lines.map(each => each.id);
      entries.push({
        kind: line.kind,
        text: line.text,
        ended,
        progress: false,
        failed: false,
        done: false,
        ids,
        open: new Set(ids),
        started: false,
      });
      settle();
      watch();
      return true;
    },
    outdate(texts) {
      const known = new Set(texts);
      for (const entry of entries) if (known.has(entry.text)) entry.progress = true;
      // The newer line is in; the older ones that only said "still working" are now stale.
      prune();
    },
    onSpeech(event) {
      const entry = entries.find(each => each.ids.includes(event.id));
      if (entry === undefined) return;
      if (event.event === 'started') entry.started = true;
      else {
        if (event.event === 'failed') entry.failed = true;
        entry.open.delete(event.id);
        if (entry.open.size === 0) {
          if (entry.failed) {
            entries = entries.filter(each => each !== entry);
            entry.ended('unplayed');
          } else entry.done = true;
          flush();
          settle();
        }
      }
    },
    hush() {
      if (entries.length === 0 && !active) return;
      deps.stream()?.hush();
      abandon();
    },
    dispose: abandon,
  };
}
