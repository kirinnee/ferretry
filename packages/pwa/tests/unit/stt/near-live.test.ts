/**
 * Proves near-live Parakeet words with a fake speech worker, a fake recorder and a fake clock:
 *
 *   - LocalAgreement-2: a word commits once two passes agree on it — and only up to a PAUSE in the
 *     audio, because a window that opens mid-speech is where the real model fails; the next window
 *     starts just before the voice resumes;
 *   - the window stays bounded on a long take (forced cuts at any pause, silence stepped past), and
 *     a window with no pause to cut at stops live words instead of growing for ever;
 *   - a pass that hears nothing in a window holding speech is a miss, not silence;
 *   - never two passes at once, a skipped pass when nothing new was heard, back-off when a pass is
 *     slow and a pause — said — when the device cannot keep up;
 *   - Stop's final pass covers only the uncommitted tail and REPLACES the interim words, falling back
 *     to the single pass when the tail is missed;
 *   - on fixtures, the near-live final text is at least as accurate as today's single pass.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  agreedPrefix,
  EMPTY_NEAR_LIVE,
  hasSpeech,
  joinWords,
  MIN_PAUSE_MS,
  MIN_SPEECH_SAMPLES,
  NEAR_LIVE_PAUSED_COPY,
  NEAR_LIVE_TIMING,
  type NearLiveState,
  NearLiveTranscriber,
  PRE_ROLL_MS,
  quietRuns,
  type TimedTranscript,
  type TimedWord,
} from '../../../src/lib/stt/near-live.ts';

const RATE = 16_000;
const at = (seconds: number): number => Math.round(seconds * RATE);
const PRE_ROLL = at(PRE_ROLL_MS / 1_000);
const word = (text: string, start: number, end: number): TimedWord => ({ text, start, end });
const heard = (...words: TimedWord[]): TimedTranscript => ({ text: words.map(w => w.text).join(' '), words });

/** Let every queued continuation run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

/** `seconds` of audio, loud inside each `[start, end)` and silent elsewhere. */
const take = (seconds: number, ...voiced: (readonly [number, number])[]): Float32Array => {
  const audio = new Float32Array(at(seconds));
  for (const [start, end] of voiced) audio.fill(0.3, at(start), Math.min(audio.length, at(end)));
  return audio;
};

interface Timer {
  readonly due: number;
  readonly callback: () => void;
  cleared: boolean;
}

/**
 * A fake worker answering scripted passes (in WINDOW time, as the real one does), a fake recorder
 * and a fake clock. Each scripted pass may say how long it "took", which advances the clock.
 */
class Rig {
  clock = 0;
  audio: Float32Array = new Float32Array(0);
  readonly timers: Timer[] = [];
  readonly states: NearLiveState[] = [];
  readonly windows: { length: number; start: number }[] = [];
  readonly finals: { samples: Float32Array; timed: boolean }[] = [];
  readonly script: { result: TimedTranscript | Error; tookMs?: number }[] = [];
  finalText = 'tail words';
  finalTimed: TimedTranscript = heard(word('tail', 0.3, 0.6), word('words', 0.7, 1));
  /** Set at Stop, so the final pass is told apart from live ones. */
  isFinal = false;
  inFlight = 0;
  maxInFlight = 0;
  peekFails = false;
  gate: Promise<void> | null = null;
  readonly transcriber: NearLiveTranscriber;

  constructor() {
    this.transcriber = new NearLiveTranscriber({
      peek: async () => {
        if (this.peekFails) throw new Error('recorder cannot be read');
        return this.audio.slice();
      },
      transcribeTimed: async samples => {
        if (this.isFinal) {
          this.finals.push({ samples, timed: true });
          return this.finalTimed;
        }
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        this.windows.push({ length: samples.length, start: this.audio.length - samples.length });
        const next = this.script.shift() ?? { result: heard() };
        this.clock += next.tookMs ?? 100;
        await (this.gate ?? Promise.resolve());
        this.inFlight -= 1;
        if (next.result instanceof Error) throw next.result;
        return next.result;
      },
      transcribe: async samples => {
        this.finals.push({ samples, timed: false });
        return this.finalText;
      },
      now: () => this.clock,
      setTimeout: (callback, milliseconds) => {
        this.timers.push({ due: this.clock + milliseconds, callback, cleared: false });
        return this.timers.length - 1;
      },
      clearTimeout: handle => {
        (this.timers[handle as number] as Timer).cleared = true;
      },
      onChange: state => this.states.push(state),
    });
  }

  /** Stop, with the whole take (or the take given). */
  async finish(samples = this.audio): Promise<string> {
    this.isFinal = true;
    return await this.transcriber.finish(samples);
  }

  pending(): Timer[] {
    return this.timers.filter(timer => !timer.cleared);
  }

  /** Fire the one pending timer, then let the pass run. */
  async fire(): Promise<void> {
    const pending = this.pending();
    should(pending).have.length(1);
    const timer = pending[0] as Timer;
    timer.cleared = true;
    this.clock = Math.max(this.clock, timer.due);
    timer.callback();
    await settle();
  }

  get last(): NearLiveState {
    return this.states.at(-1) ?? EMPTY_NEAR_LIVE;
  }
}

describe('agreedPrefix', () => {
  it('counts leading words that match, ignoring case and edge punctuation', () => {
    const a = [word('Hello', 0, 1), word('world', 1, 2), word('again', 2, 3)];
    const b = [word('hello,', 0, 1), word('world.', 1, 2), word('there', 2, 3)];
    should(agreedPrefix(a, b)).equal(2);
    should(agreedPrefix([], b)).equal(0);
    should(agreedPrefix(a, a.slice(0, 1))).equal(1);
    should(agreedPrefix([word('cat', 0, 1)], [word('cut', 0, 1)])).equal(0);
  });
});

describe('joinWords', () => {
  it('joins the non-empty parts with single spaces', () => {
    should(joinWords(' one ', '', 'two three', '  ')).equal('one two three');
    should(joinWords()).equal('');
  });
});

describe('hasSpeech and quietRuns', () => {
  it('tells a loud window from a quiet one', () => {
    should(hasSpeech(take(1, [0, 1]))).be.true();
    should(hasSpeech(take(1))).be.false();
    should(hasSpeech(new Float32Array(0))).be.false();
  });

  it('finds pauses of at least the minimum length, including one still running at the end', () => {
    const audio = take(3, [0, 1], [1.05, 2], [2.4, 2.8]);
    // 50 ms between the first two words is no pause; 400 ms is; so is the silence at the end.
    should(quietRuns(audio, 0, audio.length)).eql([
      { start: at(2), end: at(2.4) },
      { start: at(2.8), end: at(3) },
    ]);
    should(MIN_PAUSE_MS).equal(120);
  });

  it('reads quiet against the window’s own noise floor, but never lets steady speech pass as quiet', () => {
    // A noisy room: 0.004 hiss everywhere, speech at 0.3. Quiet is under 2.8 × the floor.
    const noisy = take(2, [0, 0.8], [1.2, 2]).map(sample => (sample === 0 ? 0.004 : sample));
    should(quietRuns(noisy, 0, noisy.length)).eql([{ start: at(0.8), end: at(1.2) }]);
    // Steady speech at a low level with no pause at all: nothing is quiet.
    const steady = new Float32Array(at(2)).fill(0.02);
    should(quietRuns(steady, 0, steady.length)).eql([]);
    // Pure silence is one long pause.
    should(quietRuns(take(1), 0, at(1))).eql([{ start: 0, end: at(1) }]);
  });
});

describe('NearLiveTranscriber — committing at pauses', () => {
  it('shows a first pass as interim, and commits agreed words up to the pause after them', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0.1, 0.5], [0.6, 1.2]);
    rig.script.push({ result: heard(word('the', 0.1, 0.3), word('quick', 0.6, 1.1)) });
    await rig.fire();
    should(rig.last).eql({ committed: '', interim: 'the quick', paused: false });

    // A pause at 1.2–1.6 s after "quick", then "brown" starts.
    rig.audio = take(2.4, [0.1, 0.5], [0.6, 1.2], [1.6, 2.4]);
    rig.script.push({ result: heard(word('the', 0.1, 0.3), word('quick', 0.6, 1.1), word('bro', 1.6, 2.4)) });
    await rig.fire();
    should(rig.last).eql({ committed: 'the quick', interim: 'bro', paused: false });
    // The next window opens in that pause, a pre-roll before the voice resumes.
    rig.audio = take(3.6, [0.1, 0.5], [0.6, 1.2], [1.6, 3.6]);
    rig.script.push({ result: heard(word('brown', 0.2, 1.5)) });
    await rig.fire();
    should(rig.windows[2]?.start).equal(at(1.6) - PRE_ROLL);
    should(rig.last).eql({ committed: 'the quick', interim: 'brown', paused: false });
  });

  it('keeps agreed words after the last pause as interim until a pause follows them', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    const words = [word('one', 0, 0.5), word('two', 0.6, 1.2)];
    rig.audio = take(1.2, [0, 1.2]);
    rig.script.push({ result: heard(...words) }, { result: heard(...words, word('thr', 1.3, 2.4)) });
    await rig.fire();
    rig.audio = take(2.4, [0, 2.4]);
    await rig.fire();
    // Two passes agree on "one two", but there has been no pause to cut at.
    should(rig.last).eql({ committed: '', interim: 'one two thr', paused: false });
  });

  it('never cuts past a word the passes do not agree on yet', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0, 0.4], [0.7, 1.2]);
    rig.script.push({ result: heard(word('cat', 0, 0.4), word('sat', 0.7, 1)) });
    await rig.fire();
    rig.audio = take(2.4, [0, 0.4], [0.7, 1.2], [1.5, 2.4]);
    rig.script.push({ result: heard(word('cut', 0, 0.4), word('sat', 0.7, 1), word('on', 1.5, 2)) });
    await rig.fire();
    should(rig.last.committed).equal('');
  });

  it('commits a word timed into a short pause, and drops it when the next window re-hears it', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    // A 120 ms pause at 0.5–0.62 s. Word times run early: "two" really starts at 0.62 s, but is
    // timed at 0.48 s — inside "before the pause" — so it commits with "one".
    rig.audio = take(1.2, [0, 0.5], [0.62, 1.2]);
    rig.script.push({ result: heard(word('one', 0, 0.4), word('two', 0.48, 1)) });
    await rig.fire();
    rig.audio = take(2.4, [0, 0.5], [0.62, 2.4]);
    rig.script.push({ result: heard(word('one', 0, 0.4), word('two', 0.48, 1), word('thr', 1.1, 2.4)) });
    await rig.fire();
    should(rig.last).eql({ committed: 'one two', interim: 'thr', paused: false });
    // The next window opens at the pause, so it hears "two" again at its very start.
    rig.audio = take(3.6, [0, 0.5], [0.62, 3.6]);
    rig.script.push({ result: heard(word('two', 0.1, 0.5), word('three', 0.6, 1.9)) });
    await rig.fire();
    should(rig.windows[2]?.start).equal(at(0.5));
    should(rig.last).eql({ committed: 'one two', interim: 'three', paused: false });
  });

  it('skips a pass with too little new audio, and runs it once there is enough', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(0.2, [0, 0.2]);
    await rig.fire();
    should(rig.windows).have.length(0);
    rig.audio = take(0.6, [0, 0.6]);
    await rig.fire();
    should(rig.windows).have.length(1);
  });

  it('on a long take, cuts at any pause that leaves the tail uncommitted, agreed or not', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    // Seven seconds: a word per second with a 300 ms pause after each.
    const voiced = Array.from({ length: 7 }, (_, index) => [index, index + 0.7] as const);
    const words = voiced.map(([start, end], index) => word(`w${index}`, start, end));
    rig.audio = take(7, ...voiced);
    rig.script.push({ result: heard(...words) });
    await rig.fire();
    // Nothing agreed yet, but 7 s > 6 s: the last pause ending before 7 − 2.5 = 4.5 s is 3.7–4.0 s.
    should(rig.last).eql({ committed: 'w0 w1 w2 w3', interim: 'w4 w5 w6', paused: false });
    rig.audio = take(8, ...voiced, [7, 8]);
    await rig.fire();
    should(rig.windows[1]?.start).equal(at(4) - PRE_ROLL);
  });

  it('steps past a long silence that yields no words', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(3);
    await rig.fire();
    should(rig.last).eql(EMPTY_NEAR_LIVE);
    rig.audio = take(4, [3.2, 4]);
    await rig.fire();
    // The silent pass moved the start to a pre-roll before the end of the silence it heard.
    should(rig.windows[1]?.start).equal(at(3) - PRE_ROLL);
  });

  it('treats an empty answer for a loud window as a miss: the words stay and the next pass retries', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0, 1.2]);
    rig.script.push({ result: heard(word('hello', 0, 0.5)) });
    await rig.fire();
    rig.audio = take(2.4, [0, 2.4]);
    rig.script.push({ result: heard() });
    await rig.fire();
    should(rig.states).have.length(1);
    should(rig.last.interim).equal('hello');
    rig.audio = take(3.6, [0, 3.6]);
    rig.script.push({ result: heard(word('hello', 0, 0.5), word('there', 0.6, 1)) });
    await rig.fire();
    // The retry started where the missed pass did.
    should(rig.windows[2]?.start).equal(0);
    should(rig.last.interim).equal('hello there');
  });

  it('stops live words quietly when a window outgrows its hard bound with no pause to cut at', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(17, [0, 17]);
    rig.script.push({ result: heard(word('on', 0, 1)), tookMs: 100 });
    await rig.fire();
    should(rig.pending()).have.length(0);
    should(rig.last.paused).be.false();
  });

  it('never runs two passes at once', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    for (let index = 1; index <= 6; index += 1) {
      rig.audio = take(1.2 * index, [0, 1.2 * index]);
      rig.script.push({ result: heard(word('same', 0.1, 0.4)), tookMs: 300 });
      await rig.fire();
    }
    should(rig.maxInFlight).equal(1);
    // The next pass is scheduled only after the previous one answered, so one timer is ever pending.
    should(rig.pending()).have.length(1);
  });
});

describe('NearLiveTranscriber — pacing', () => {
  it('keeps the interval while passes are quick, waiting out the rest of it', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0, 1.2]);
    rig.script.push({ result: heard(word('hi', 0, 0.3)), tookMs: 200 });
    await rig.fire();
    should(rig.transcriber.intervalMs).equal(1_200);
    should((rig.pending()[0] as Timer).due - rig.clock).equal(1_000);
  });

  it('backs the interval off when a pass takes most of it, up to the ceiling', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(3, [0, 3]);
    rig.script.push({ result: heard(word('a', 0, 1)), tookMs: 1_000 });
    await rig.fire();
    should(rig.transcriber.intervalMs).equal(2_400);
    rig.audio = take(6, [0, 6]);
    rig.script.push({ result: heard(word('a', 0, 1)), tookMs: 2_000 });
    await rig.fire();
    should(rig.transcriber.intervalMs).equal(4_800);
    // A pass longer than the interval schedules the next at once rather than after a negative wait.
    rig.audio = take(12, [0, 12]);
    rig.script.push({ result: heard(word('a', 0, 1)), tookMs: 4_000 });
    await rig.fire();
    should(rig.transcriber.intervalMs).equal(4_800);
    should(rig.last.paused).be.false();
  });

  it('pauses live words when a pass takes longer than even the longest interval, and says so', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(10, [0, 10]);
    rig.script.push({ result: heard(word('slow', 0.1, 0.5)), tookMs: NEAR_LIVE_TIMING.maxIntervalMs + 1 });
    await rig.fire();
    should(rig.last).eql({ committed: '', interim: 'slow', paused: true });
    should(rig.pending()).have.length(0);
    should(NEAR_LIVE_PAUSED_COPY).equal('live words paused — device too slow');
  });

  it('pauses when a pass of at least three seconds is slower than real time', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(3, [0, 3]);
    rig.script.push({ result: heard(word('hi', 0, 0.3)), tookMs: 3_000 });
    await rig.fire();
    should(rig.last.paused).be.true();
  });

  it('only backs off when a very short window is slower than real time', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0, 1.2]);
    rig.script.push({ result: heard(word('hi', 0, 0.3)), tookMs: 1_300 });
    await rig.fire();
    should(rig.last.paused).be.false();
    should(rig.transcriber.intervalMs).equal(2_400);
  });

  it('a failed pass stops live words quietly; Stop still transcribes everything', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0, 1.2]);
    rig.script.push({ result: new Error('worker broke') });
    await rig.fire();
    should(rig.states).eql([]);
    should(rig.pending()).have.length(0);
    should(await rig.finish()).equal('tail words');
    should(rig.finals[0]?.samples.length).equal(rig.audio.length);
  });

  it('a recorder that cannot be read mid-take stops live words the same way', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.peekFails = true;
    rig.audio = take(1.2, [0, 1.2]);
    await rig.fire();
    should(rig.windows).have.length(0);
    should(rig.pending()).have.length(0);
  });
});

describe('NearLiveTranscriber — Stop and cancel', () => {
  /** "keep me" committed at the pause 1.0–1.4 s; "maybee" interim after it. */
  const committedRig = async (): Promise<Rig> => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0, 1]);
    rig.script.push({ result: heard(word('keep', 0, 0.5), word('me', 0.6, 1)) });
    await rig.fire();
    rig.audio = take(2.4, [0, 1], [1.4, 2.4]);
    rig.script.push({ result: heard(word('keep', 0, 0.5), word('me', 0.6, 1), word('maybee', 1.45, 2.4)) });
    await rig.fire();
    should(rig.last).eql({ committed: 'keep me', interim: 'maybee', paused: false });
    return rig;
  };

  it('replaces the interim words with one final pass over the uncommitted tail', async () => {
    const rig = await committedRig();
    rig.finalTimed = heard(word('maybe', 0.2, 0.6), word('not', 0.7, 1));
    should(await rig.finish()).equal('keep me maybe not');
    // The tail starts in the pause, a pre-roll before "maybe".
    should(rig.finals[0]?.samples.length).equal(rig.audio.length - (at(1.4) - PRE_ROLL));
    should(rig.finals[0]?.timed).be.true();
    should(rig.pending()).have.length(0);
  });

  it('drops a committed word the final pass re-hears', async () => {
    const rig = await committedRig();
    rig.finalTimed = heard(word('me', 0, 0.1), word('maybe', 0.2, 0.6));
    should(await rig.finish()).equal('keep me maybe');
  });

  it('falls back to the single pass when the final pass misses a tail that holds speech', async () => {
    const rig = await committedRig();
    rig.finalTimed = heard();
    rig.finalText = 'keep me maybe so';
    should(await rig.finish()).equal('keep me maybe so');
    should(rig.finals.map(final => final.timed)).eql([true, false]);
    should(rig.finals[1]?.samples.length).equal(rig.audio.length);

    const empty = await committedRig();
    empty.finalTimed = heard();
    empty.finalText = '';
    should(await empty.finish()).equal('keep me');
  });

  it('keeps the committed words when the tail is silence', async () => {
    const rig = await committedRig();
    rig.finalTimed = heard();
    should(await rig.finish(take(2.4, [0, 1]))).equal('keep me');
    should(rig.finals).have.length(1);
  });

  it('returns only the committed words when the tail is too short to be speech', async () => {
    const rig = await committedRig();
    const cut = at(1.4) - PRE_ROLL;
    should(await rig.finish(rig.audio.subarray(0, cut + MIN_SPEECH_SAMPLES - 1))).equal('keep me');
    should(rig.finals).have.length(0);
  });

  it('with nothing committed, the final pass is today’s single pass over the whole take', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(0.2, [0, 0.2]);
    should(await rig.finish()).equal('');
    const again = new Rig();
    again.audio = take(2, [0, 2]);
    should(await again.finish()).equal('tail words');
    should(again.finals).eql([{ samples: again.audio, timed: false }]);
  });

  it('drops a pass still in flight at Stop instead of waiting for it', async () => {
    const rig = await committedRig();
    rig.audio = take(3.6, [0, 1], [1.4, 3.6]);
    let release: () => void = () => undefined;
    rig.gate = new Promise<void>(resolve => (release = resolve));
    rig.script.push({ result: heard(word('maybe', 0.2, 0.6), word('late', 0.7, 1)) });
    const pending = rig.pending()[0] as Timer;
    pending.cleared = true;
    pending.callback();
    await settle();
    should(rig.inFlight).equal(1);
    should(await rig.finish()).equal('keep me tail words');
    release();
    await settle();
    should(rig.last).eql({ committed: 'keep me', interim: 'maybee', paused: false });
  });

  it('cancel stops passes and a pass already answering changes nothing', async () => {
    const rig = new Rig();
    rig.transcriber.start();
    rig.audio = take(1.2, [0, 1.2]);
    const pending = rig.pending()[0] as Timer;
    pending.cleared = true;
    pending.callback();
    rig.transcriber.cancel();
    await settle();
    should(rig.states).eql([]);
    should(rig.pending()).have.length(0);
    rig.transcriber.cancel();
  });
});

/**
 * ACCURACY ON FIXTURES. A deterministic fake acoustic model: each word of a sentence is a run of
 * identical samples between pauses. Like the real model, it hears a word fully only when the window
 * holds all of it, mishears a word cut by the window's start as a fragment, hears a word still being
 * spoken as a prefix, is unsure of the last word heard (it may come back different on the next
 * pass), and times words a little early. Today's single pass over the whole take hears every word
 * whole; the near-live final text must be at least as accurate, and in particular must never lose
 * or repeat a word at a window boundary.
 */
describe('NearLiveTranscriber — accuracy against the single pass', () => {
  const FIXTURES = [
    'he hoped there would be stew for dinner turnips and carrots and bruised potatoes and fat mutton pieces to be ladled out in thick peppered flour fattened sauce',
    'stuff it into you his belly counselled him',
    'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels',
    'ferretry runs agents on your own machine and dictation never sends audio to the daemon it only updates your draft so nothing is sent for you until you press send yourself after reading it twice',
  ];
  const GAP_S = 0.16;
  const TRAIL_S = 0.6;
  const FRAME_S = 0.08;
  const EARLY_S = 0.1;

  interface Encoded {
    readonly audio: Float32Array;
    readonly words: readonly string[];
  }

  /** Each word is a run of one loud value that names it, between silences. */
  const encode = (sentence: string): Encoded => {
    const words = sentence.split(' ');
    const parts: number[] = [];
    words.forEach((text, index) => {
      for (let s = 0; s < Math.round(GAP_S * RATE); s += 1) parts.push(0);
      const length = Math.round((0.18 + 0.06 * text.length) * RATE);
      for (let s = 0; s < length; s += 1) parts.push(0.1 + index / 1_000);
    });
    for (let s = 0; s < Math.round(TRAIL_S * RATE); s += 1) parts.push(0);
    return { audio: Float32Array.from(parts), words };
  };

  /** What the fake model hears in one window. */
  const listen = (fixture: Encoded, samples: Float32Array): TimedTranscript => {
    const heardWords: TimedWord[] = [];
    let index = 0;
    while (index < samples.length) {
      const value = samples[index] as number;
      if (value === 0) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < samples.length && samples[index] === value) index += 1;
      const text = fixture.words[Math.round((value - 0.1) * 1_000)] as string;
      const cutAtStart = start === 0;
      const stillSpeaking = index === samples.length;
      const startS = Math.max(0, Math.floor(start / RATE / FRAME_S) * FRAME_S - EARLY_S);
      const endS = Math.ceil(index / RATE / FRAME_S) * FRAME_S - EARLY_S;
      let said = text;
      if (cutAtStart) said = `~${text.slice(-2)}`;
      else if (stillSpeaking) said = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
      else if (samples.length - index < 0.3 * RATE) said = `${text}h`;
      heardWords.push({ text: said, start: startS, end: endS });
    }
    return { text: heardWords.map(w => w.text).join(' '), words: heardWords };
  };

  const wordErrorRate = (reference: string, hypothesis: string): number => {
    const ref = reference.split(' ').filter(Boolean);
    const hyp = hypothesis.split(' ').filter(Boolean);
    let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
    for (let i = 1; i <= ref.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= hyp.length; j += 1)
        next[j] = Math.min(
          (row[j] as number) + 1,
          (next[j - 1] as number) + 1,
          (row[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
        );
      row = next;
    }
    return (row[hyp.length] as number) / ref.length;
  };

  /** Feed the take in real time, passes paced by the fake clock, then Stop. */
  const nearLive = async (fixture: Encoded, rtf: number): Promise<{ text: string; states: NearLiveState[] }> => {
    let clock = 0;
    const timers: { due: number; callback: () => void; cleared: boolean }[] = [];
    const states: NearLiveState[] = [];
    const recorded = (): Float32Array => fixture.audio.subarray(0, Math.min(fixture.audio.length, clock * 16));
    const live = new NearLiveTranscriber({
      peek: async () => recorded().slice(),
      transcribeTimed: async samples => {
        clock += (samples.length / 16) * rtf;
        return listen(fixture, samples);
      },
      transcribe: async samples => listen(fixture, samples).text,
      now: () => clock,
      setTimeout: (callback, milliseconds) => timers.push({ due: clock + milliseconds, callback, cleared: false }) - 1,
      clearTimeout: handle => {
        (timers[handle as number] as { cleared: boolean }).cleared = true;
      },
      onChange: state => states.push(state),
    });
    live.start();
    const durationMs = fixture.audio.length / 16;
    for (;;) {
      const next = timers.find(timer => !timer.cleared);
      if (next === undefined || next.due > durationMs) break;
      next.cleared = true;
      clock = Math.max(clock, next.due);
      next.callback();
      await settle();
    }
    clock = durationMs;
    return { text: await live.finish(fixture.audio), states };
  };

  for (const [index, sentence] of FIXTURES.entries()) {
    it(`fixture ${index + 1}: the near-live final text is at least as accurate as one pass`, async () => {
      const fixture = encode(sentence);
      const single = listen(fixture, fixture.audio).text;
      const { text, states } = await nearLive(fixture, 0.1);
      should(wordErrorRate(sentence, text)).be.belowOrEqual(wordErrorRate(sentence, single));
      should(text).equal(sentence);
      // The live words really were live: words committed before Stop.
      should(states.some(state => state.committed !== '')).be.true();
    });
  }

  it('on a device too slow to keep up, live words pause and the final text is still the single pass', async () => {
    const fixture = encode(FIXTURES[0] as string);
    const { text, states } = await nearLive(fixture, 1.5);
    should(states.at(-1)?.paused).be.true();
    should(text).equal(listen(fixture, fixture.audio).text);
  });
});
