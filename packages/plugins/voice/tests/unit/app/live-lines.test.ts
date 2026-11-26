import { describe, expect, test } from 'bun:test';
import { createLiveLines, staleProgress, type WaitingLine } from '../../../app/lib/voice-mode/live-lines.ts';
import type { ReplyPlayer, SpeechLineEvent } from '../../../app/lib/stream/voice-stream.ts';

/**
 * V4, the queue policy: a progress line that a newer line outdates while it still waits is dropped; the first line of a turn,
 * the result and a line already being heard never are. And the machine's voice end to end over a fake stream: a line is spoken
 * the moment it is handed over (it never waits for the turn), behind whatever is playing.
 */

describe('the queue policy: which waiting lines a newer arrival outdates', () => {
  const waiting = (...lines: [WaitingLine['kind'], boolean?][]): WaitingLine[] =>
    lines.map(([kind, started]) => ({ kind, started: started === true }));

  test('only progress lines that nobody has started to hear', () => {
    expect(staleProgress(waiting(['first'], ['progress'], ['progress', true], ['result'], ['progress']))).toEqual([
      1, 4,
    ]);
  });

  test('the first line and the result are never stale, whatever arrives after them', () => {
    expect(staleProgress(waiting(['first'], ['result']))).toEqual([]);
    expect(staleProgress([])).toEqual([]);
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
            hush: () => {
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
  };
}

const heard = (id: number, event: SpeechLineEvent['event']): SpeechLineEvent => ({ id, event });

describe('live lines: speaking while the ferret works', () => {
  test('a line is handed to the machine voice at once, with no wait for the turn', () => {
    const f = fake();
    expect(f.lines.say({ text: 'Looking now.', kind: 'first' })).toBe(true);
    expect(f.spoken).toEqual([{ id: 0, text: 'Looking now.' }]);
    expect(f.active).toEqual([true]);
  });

  test('a newer progress line drops the waiting progress lines, never the first line or the result', () => {
    const f = fake();
    f.lines.say({ text: 'First.', kind: 'first' });
    f.lines.say({ text: 'Step one.', kind: 'progress' }); // waits behind the first line
    f.lines.say({ text: 'Step two.', kind: 'progress' }); // outdates step one
    expect(f.dropped).toEqual([1]);
    f.lines.say({ text: 'All done.', kind: 'result' }); // outdates step two, never itself
    expect(f.dropped).toEqual([1, 2]);
    // The first line and the result are still there: nothing asked for them to go.
    expect(f.spoken.map(each => each.text)).toEqual(['First.', 'Step one.', 'Step two.', 'All done.']);
    expect(f.dropped).not.toContain(0);
    expect(f.dropped).not.toContain(3);
  });

  test('a progress line already being heard is not taken back, and a first line stays through any number of arrivals', () => {
    const f = fake();
    f.lines.say({ text: 'First.', kind: 'first' });
    f.lines.say({ text: 'Step one.', kind: 'progress' });
    f.lines.onSpeech(heard(1, 'started'));
    f.lines.say({ text: 'Step two.', kind: 'progress' });
    f.lines.say({ text: 'Step three.', kind: 'progress' });
    // Step one is audible; step two waited and was outdated by three. The first line was never a candidate.
    expect(f.dropped).toEqual([2]);
  });

  test('a line that has finished arriving is no longer waiting', () => {
    const f = fake();
    f.lines.say({ text: 'Step one.', kind: 'progress' });
    f.lines.onSpeech(heard(0, 'started'));
    f.lines.onSpeech(heard(0, 'finished'));
    f.lines.say({ text: 'Step two.', kind: 'progress' });
    expect(f.dropped).toEqual([]);
  });

  test('a machine voice that is absent, or no stream, takes nothing, so the end-of-turn reading keeps it', () => {
    expect(fake({ reply: 'absent' }).lines.say({ text: 'x', kind: 'first' })).toBe(false);
    expect(fake({ streamOpen: false }).lines.say({ text: 'x', kind: 'first' })).toBe(false);
    // A voice still loading is not absent: the machine queues the line and speaks it as soon as it is ready.
    expect(fake({ reply: 'loading' }).lines.say({ text: 'x', kind: 'first' })).toBe(true);
  });

  test('it is active until its sound has been heard, then says so once', () => {
    const f = fake();
    f.lines.say({ text: 'Step one.', kind: 'first' });
    f.lines.onSpeech(heard(0, 'started'));
    f.lines.onSpeech(heard(0, 'finished'));
    f.remaining = 800;
    f.tick();
    expect(f.active).toEqual([true]);
    f.remaining = 0;
    f.tick();
    expect(f.active).toEqual([true, false]);
  });

  test('barge-in hushes the stream once, forgets what waited and goes quiet', () => {
    const f = fake();
    f.lines.say({ text: 'First.', kind: 'first' });
    f.lines.say({ text: 'Step one.', kind: 'progress' });
    f.lines.hush();
    expect(f.hushes()).toBe(1);
    expect(f.active).toEqual([true, false]);
    // Nothing is left to be outdated by the next line.
    f.lines.say({ text: 'Step two.', kind: 'progress' });
    expect(f.dropped).toEqual([]);
    f.lines.hush();
    f.lines.hush();
    expect(f.hushes()).toBe(2);
  });
});
