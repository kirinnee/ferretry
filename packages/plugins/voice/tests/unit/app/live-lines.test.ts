import { describe, expect, test } from 'bun:test';
import { createLiveLines, staleProgress, type WaitingLine } from '../../../app/lib/voice-mode/live-lines.ts';
import type { ReplyPlayer, SpeechLineEvent } from '../../../app/lib/stream/voice-stream.ts';

/**
 * V4, the queue policy: a line KNOWN to be progress that a newer line outdates while it still waits is dropped; the first line of a
 * turn, any line not known to be progress (the result among them) and a line already being heard never are. And the machine's voice end to end over a fake stream: a line is spoken
 * the moment it is handed over (it never waits for the turn), behind whatever is playing.
 */

describe('the queue policy: which waiting lines a newer one outdates', () => {
  const waiting = (...lines: [WaitingLine['kind'], boolean, boolean?][]): WaitingLine[] =>
    lines.map(([kind, progress, started]) => ({ kind, progress, started: started === true }));

  test('only lines KNOWN to be progress, that nobody has started to hear, with a newer line behind them', () => {
    expect(
      staleProgress(
        waiting(['first', true], ['line', true], ['line', true, true], ['line', false], ['line', true], ['line', true]),
      ),
    ).toEqual([1, 4]);
  });

  test('a line nobody called progress is kept, however many arrive after it', () => {
    expect(staleProgress(waiting(['first', false], ['line', false], ['line', false], ['line', false]))).toEqual([]);
    expect(staleProgress([])).toEqual([]);
  });

  test('the newest line is never outdated, and the first line of a turn is never outdated', () => {
    expect(staleProgress(waiting(['first', true], ['line', true]))).toEqual([]);
  });
});

interface Fake {
  readonly spoken: { id: number; text: string }[];
  readonly dropped: number[];
  readonly hushes: () => number;
  readonly lines: ReturnType<typeof createLiveLines>;
  readonly active: boolean[];
  /** Milliseconds of sound the player still holds. */
  remaining: number;
  tick(): void;
  /** Whether the drain check is still running. */
  polling(): boolean;
}

function fake(options: { reply?: 'ready' | 'absent' | 'loading' | undefined; streamOpen?: boolean } = {}): Fake {
  const spoken: Fake['spoken'] = [];
  const dropped: number[] = [];
  let hushed = 0;
  let nextId = 0;
  let ticker: (() => void) | undefined;
  const active: boolean[] = [];
  const state = { remaining: 0 };
  const player: Pick<ReplyPlayer, 'remainingMs'> = { remainingMs: () => state.remaining };
  const lines = createLiveLines({
    stream: () =>
      options.streamOpen === false
        ? undefined
        : {
            speak: text => {
              const id = nextId;
              nextId += 1;
              spoken.push({ id, text });
              return [{ id, text }];
            },
            drop: ids => void dropped.push(...ids),
            interrupt: () => {
              hushed += 1;
            },
          },
    replyState: () => (options.reply === undefined && 'reply' in options ? undefined : (options.reply ?? 'ready')),
    player,
    onActive: next => void active.push(next),
    every: tick => {
      ticker = tick;
      return () => {
        ticker = undefined;
      };
    },
  });
  return {
    spoken,
    dropped,
    hushes: () => hushed,
    lines,
    active,
    get remaining() {
      return state.remaining;
    },
    set remaining(value: number) {
      state.remaining = value;
    },
    tick: () => ticker?.(),
    polling: () => ticker !== undefined,
  };
}

const heard = (id: number, event: SpeechLineEvent['event']): SpeechLineEvent => ({ id, event });
const noop = (): void => undefined;
/** Records what became of each line: `outcomes[text]`. */
const track = (): { outcomes: Record<string, string>; ended: (text: string) => (outcome: string) => void } => {
  const outcomes: Record<string, string> = {};
  return {
    outcomes,
    ended: text => outcome => {
      outcomes[text] = outcome;
    },
  };
};

describe('live lines: speaking while the ferret works', () => {
  test('a line is handed to the machine voice at once, with no wait for the turn', () => {
    const f = fake();
    expect(f.lines.say({ id: 'Looking now.', text: 'Looking now.', kind: 'first' }, noop)).toBe(true);
    expect(f.spoken).toEqual([{ id: 0, text: 'Looking now.' }]);
    expect(f.active).toEqual([true]);
  });

  test('a newer line takes back a waiting line KNOWN to be progress, never the first line or an unmarked one', () => {
    const f = fake();
    const t = track();
    f.lines.say({ id: 'First.', text: 'First.', kind: 'first' }, t.ended('First.'));
    f.lines.say({ id: 'Step one.', text: 'Step one.', kind: 'line' }, t.ended('Step one.')); // waits behind the first line
    f.lines.say({ id: 'Step two.', text: 'Step two.', kind: 'line' }, t.ended('Step two.'));
    // Nothing said that step one is progress: it is kept.
    expect(f.dropped).toEqual([]);
    f.lines.outdate(['First.', 'Step one.']);
    // The first line is never a candidate; step one is progress with a newer line behind it.
    expect(f.dropped).toEqual([1]);
    expect(t.outcomes).toEqual({ 'Step one.': 'dropped' });
    expect(f.spoken.map(each => each.text)).toEqual(['First.', 'Step one.', 'Step two.']);
  });

  test('the newest line is kept even when it is called progress: nothing is behind it', () => {
    const f = fake();
    f.lines.say({ id: 'First.', text: 'First.', kind: 'first' }, noop);
    f.lines.say({ id: 'Step one.', text: 'Step one.', kind: 'line' }, noop);
    f.lines.outdate(['Step one.']);
    expect(f.dropped).toEqual([]);
    f.lines.say({ id: 'Step two.', text: 'Step two.', kind: 'line' }, noop);
    // The arrival of a newer line is what takes the older progress line back.
    f.lines.outdate(['Step one.']);
    expect(f.dropped).toEqual([1]);
  });

  test('a progress line already being heard is not taken back', () => {
    const f = fake();
    f.lines.say({ id: 'First.', text: 'First.', kind: 'first' }, noop);
    f.lines.say({ id: 'Step one.', text: 'Step one.', kind: 'line' }, noop);
    f.lines.onSpeech(heard(1, 'started'));
    f.lines.say({ id: 'Step two.', text: 'Step two.', kind: 'line' }, noop);
    f.lines.outdate(['Step one.']);
    expect(f.dropped).toEqual([]);
  });

  test('a line is PLAYED only once the player has finished with its sound', () => {
    const f = fake();
    const t = track();
    f.lines.say({ id: 'Step one.', text: 'Step one.', kind: 'first' }, t.ended('Step one.'));
    f.lines.onSpeech(heard(0, 'started'));
    f.remaining = 800;
    f.lines.onSpeech(heard(0, 'finished'));
    expect(t.outcomes).toEqual({});
    f.tick();
    expect(t.outcomes).toEqual({});
    f.remaining = 0;
    f.tick();
    expect(t.outcomes).toEqual({ 'Step one.': 'played' });
  });

  test('a line whose sound failed is told as failed', () => {
    const f = fake();
    const t = track();
    f.lines.say({ id: 'Step one.', text: 'Step one.', kind: 'first' }, t.ended('Step one.'));
    f.lines.onSpeech({ id: 0, event: 'failed', code: 'reply_voice_failed' });
    expect(t.outcomes).toEqual({ 'Step one.': 'failed' });
  });

  test('a machine voice that is absent, or no stream, takes nothing, so the end-of-turn reading keeps it', () => {
    expect(fake({ reply: 'absent' }).lines.say({ id: 'x', text: 'x', kind: 'first' }, noop)).toBe(false);
    expect(fake({ streamOpen: false }).lines.say({ id: 'x', text: 'x', kind: 'first' }, noop)).toBe(false);
    // A voice still loading is not absent: the machine queues the line and speaks it as soon as it is ready.
    expect(fake({ reply: 'loading' }).lines.say({ id: 'x', text: 'x', kind: 'first' }, noop)).toBe(true);
  });

  test('it is active until its sound has been heard, then says so once', () => {
    const f = fake();
    f.lines.say({ id: 'Step one.', text: 'Step one.', kind: 'first' }, noop);
    f.lines.onSpeech(heard(0, 'started'));
    f.remaining = 800;
    f.lines.onSpeech(heard(0, 'finished'));
    f.tick();
    expect(f.active).toEqual([true]);
    f.remaining = 0;
    f.tick();
    expect(f.active).toEqual([true, false]);
  });

  test('barge-in hushes the stream once, tells what waited as unplayed and goes quiet', () => {
    const f = fake();
    const t = track();
    f.lines.say({ id: 'First.', text: 'First.', kind: 'first' }, t.ended('First.'));
    f.lines.say({ id: 'Step one.', text: 'Step one.', kind: 'line' }, t.ended('Step one.'));
    f.lines.hush();
    expect(f.hushes()).toBe(1);
    expect(f.active).toEqual([true, false]);
    expect(t.outcomes).toEqual({ 'First.': 'unplayed', 'Step one.': 'unplayed' });
    // Nothing is left to be outdated by the next line.
    f.lines.say({ id: 'Step two.', text: 'Step two.', kind: 'line' }, noop);
    f.lines.outdate(['Step one.']);
    expect(f.dropped).toEqual([]);
    f.lines.hush();
    f.lines.hush();
    expect(f.hushes()).toBe(2);
  });

  test('when the panel goes away nothing stays polled, and what had not played is told as unplayed', () => {
    const f = fake();
    const t = track();
    f.lines.say({ id: 'First.', text: 'First.', kind: 'first' }, t.ended('First.'));
    expect(f.polling()).toBe(true);
    f.lines.dispose();
    expect(f.polling()).toBe(false);
    expect(t.outcomes).toEqual({ 'First.': 'unplayed' });
    expect(f.active).toEqual([true, false]);
    // A second dispose is harmless.
    f.lines.dispose();
    expect(f.active).toEqual([true, false]);
  });
});
