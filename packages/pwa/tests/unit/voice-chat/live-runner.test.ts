/**
 * Proves the Live runner end to end with fake ports and the REAL machine and endpointer: synthetic
 * level frames drive a turn, a fake clock runs the countdown, and the assertions are about what the
 * loop DID — what it showed, when it sent, what it closed — not about its internals.
 *
 *   - a whole turn: frames → words on screen → ring → settle → send → working → reply → listening;
 *   - voice returning during the ring cancels the send and the early finish; a late answer is ignored;
 *   - typing, hold, a hidden tab, a failed send, an empty take, a question, the ferret stopping;
 *   - refusals: another tab, a blocked microphone, a meter that cannot open; the wake lock refused;
 *   - generations: a microphone closed while its permission was pending is never reopened;
 *   - reading with a speaker, and the lack of one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { LiveEvent } from '../../../src/lib/voice-chat/live-machine.ts';
import { LEVEL_HISTORY, LiveRunner, type LiveRunnerPorts } from '../../../src/lib/voice-chat/live-runner.ts';
import type {
  LevelMeterHandle,
  ReplyFeedPort,
  ReplySignal,
  SendOutcome,
  SendTicket,
  TakeHandle,
  TakeListener,
  TakeOutcome,
} from '../../../src/lib/voice-chat/ports.ts';
import { type ReplySnapshot, type ReplySource, sessionReplyFeed } from '../../../src/lib/voice-chat/reply-feed.ts';
import type { LevelFrame } from '../../../src/lib/voice-chat/turn-endpointer.ts';

const LOUD = 0.1;
const QUIET = 0.001;

class FakeClock {
  now_ = 0;
  readonly pending: { at: number; run: () => void; live: boolean }[] = [];
  now = (): number => this.now_;
  after = (ms: number, run: () => void): (() => void) => {
    const entry = { at: this.now_ + ms, run, live: true };
    this.pending.push(entry);
    return () => {
      entry.live = false;
    };
  };
  /** Move time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.now_ + ms;
    for (;;) {
      const due = this.pending.filter(entry => entry.live && entry.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.live = false;
      this.now_ = due.at;
      due.run();
    }
    this.now_ = target;
  }
  get live(): number {
    return this.pending.filter(entry => entry.live).length;
  }
}

class FakeTake implements TakeHandle {
  endTurns = 0;
  resumes = 0;
  cancelled = false;
  stopped = false;
  outcome: Promise<TakeOutcome> = Promise.resolve({
    kind: 'words',
    text: 'Fix the bug.',
    raw: 'fix the bug',
    cleaned: true,
  });
  resumeResult = true;
  endTurn(): Promise<TakeOutcome> {
    this.endTurns += 1;
    return this.outcome;
  }
  resume(): Promise<boolean> {
    this.resumes += 1;
    return Promise.resolve(this.resumeResult);
  }
  stopRecording(): void {
    this.stopped = true;
  }
  cancel(): void {
    this.cancelled = true;
  }
}

interface Rig {
  readonly runner: LiveRunner;
  readonly clock: FakeClock;
  readonly takes: FakeTake[];
  readonly listeners: TakeListener[];
  readonly shown: string[];
  readonly sends: number[];
  readonly turns: unknown[];
  readonly log: string[];
  /** Feed one 20 ms frame at the current clock time + 20. */
  frame(rms: number): void;
  /** `ms` of a level, one frame per 20 ms, advancing the clock and the frames together. */
  talk(rms: number, ms: number): void;
  settle(): Promise<void>;
  /** `silent`: the page is hidden but the browser's event has not been delivered yet. */
  setVisible(visible: boolean, silent?: boolean): void;
  signal(signal: ReplySignal): void;
  sendResult: { current: SendOutcome | 'pending' };
  releaseSend(outcome: SendOutcome): void;
  /** When each `SendPort.seal` happened (a new take was opened). */
  readonly sealed: number[];
  /** Every ticket `send` was handed, newest last. */
  readonly tickets: SendTicket[];
  /** `queued`: the composer has not rendered the words yet — `startQueuedSend` is its commit-and-send. */
  readonly composer: { queued: boolean };
  startQueuedSend(index?: number): void;
  lock: { granted: boolean };
  /** The text a person typed in the box (what `SendPort.typed` answers). */
  typed: { current: string };
  /** `pending`: the lock is not decided until `answerLock` says so (like the browser's asynchronous queue). */
  lockControl: { pending: boolean };
  /** Decide the `index`th lock request. */
  answerLock(index: number, granted: boolean): Promise<void>;
  wake: { granted: boolean };
  meterOpen: { mode: 'ok' | 'null' | 'reject' | 'pending' };
  openMeter(): void;
  meterReleased: number;
  speaker: { spoke: number; stopped: number; done: () => void };
}

const rig = (options: { speaker?: boolean; canSend?: boolean; graceMs?: unknown; reply?: ReplyFeedPort } = {}): Rig => {
  const clock = new FakeClock();
  const takes: FakeTake[] = [];
  const listeners: TakeListener[] = [];
  const shown: string[] = [];
  const sends: number[] = [];
  const turns: unknown[] = [];
  const log: string[] = [];
  let onFrame: (frame: LevelFrame) => void = () => undefined;
  let visible = true;
  const visibilityListeners = new Set<(visible: boolean) => void>();
  let replyListener: ((signal: ReplySignal) => void) | null = null;
  const typed = { current: '' };
  const sendResult: Rig['sendResult'] = { current: { kind: 'sent', sentAtMs: 0 } };
  let releaseSend: (outcome: SendOutcome) => void = () => undefined;
  const tickets: SendTicket[] = [];
  const sealed: number[] = [];
  const composer = { queued: false };
  const queuedStarts: (() => void)[] = [];
  const lock = { granted: true };
  const lockControl = { pending: false };
  const lockAnswers: ((granted: boolean) => void)[] = [];
  const wake = { granted: true };
  const meterOpen: Rig['meterOpen'] = { mode: 'ok' };
  let pendingMeter: (() => void) | null = null;
  let meterReleased = 0;
  const speaker: { spoke: number; stopped: number; done: () => void } = { spoke: 0, stopped: 0, done: () => undefined };
  let frameAt = 0;

  const meter: LevelMeterHandle = {
    recent: () => [QUIET, QUIET],
    release: () => {
      meterReleased += 1;
    },
  };

  const ports: LiveRunnerPorts = {
    take: {
      start: listener => {
        const take = new FakeTake();
        takes.push(take);
        listeners.push(listener);
        log.push('take.start');
        return take;
      },
    },
    levels: {
      open: frameHandler => {
        onFrame = frameHandler;
        if (meterOpen.mode === 'reject') return Promise.reject(new Error('no mic'));
        if (meterOpen.mode === 'null') return Promise.resolve(null);
        if (meterOpen.mode === 'pending')
          return new Promise(resolve => {
            pendingMeter = () => resolve(meter);
          });
        return Promise.resolve(meter);
      },
    },
    send: {
      show: text => void shown.push(text),
      clear: () => void shown.push('<cleared>'),
      seal: () => void sealed.push(clock.now()),
      shown: () => shown.at(-1) ?? '',
      typed: () => typed.current,
      send: ticket => {
        tickets.push(ticket);
        // The composer commits the ticket the instant before it sends; until then the send is only queued.
        const go = (): Promise<SendOutcome> => {
          if (!ticket.commit()) return Promise.resolve({ kind: 'failed', reason: 'revoked' });
          log.push('send');
          sends.push(clock.now());
          if (sendResult.current === 'pending')
            return new Promise<SendOutcome>(resolve => {
              releaseSend = resolve;
            });
          return Promise.resolve(sendResult.current);
        };
        if (!composer.queued) return go();
        return new Promise<SendOutcome>(resolve => {
          queuedStarts.push(() => resolve(go()));
        });
      },
    },
    reply: options.reply ?? {
      arm: () => {
        log.push('reply.arm');
        return {
          attach: listener => {
            replyListener = listener;
            log.push('reply.watch');
            return () => {
              replyListener = null;
              log.push('reply.stop');
            };
          },
          cancel: () => void log.push('reply.cancel'),
        };
      },
    },
    speaker: options.speaker
      ? {
          speak: onDone => {
            speaker.spoke += 1;
            speaker.done = onDone;
          },
          stop: () => {
            speaker.stopped += 1;
          },
        }
      : null,
    wakeLock: {
      acquire: () => Promise.resolve(wake.granted),
      release: () => void log.push('wake.release'),
    },
    visibility: {
      visible: () => visible,
      watch: listener => {
        visibilityListeners.add(listener);
        return () => void visibilityListeners.delete(listener);
      },
    },
    micLock: {
      acquire: () => {
        log.push('lock.acquire');
        if (lockControl.pending)
          return new Promise<boolean>(resolve => {
            lockAnswers.push(resolve);
          });
        return Promise.resolve(lock.granted);
      },
      release: () => void log.push('lock.release'),
    },
    clock,
  };
  const runner = new LiveRunner(ports, {
    canSend: options.canSend ?? true,
    graceMs: options.graceMs,
    onTurn: turn => void turns.push(turn),
  });
  const rigResult: Rig = {
    runner,
    clock,
    takes,
    listeners,
    shown,
    sends,
    turns,
    log,
    frame: rms => {
      frameAt = Math.max(frameAt, clock.now()) + 20;
      onFrame({ atMs: frameAt, rms });
    },
    talk: (rms, ms) => {
      for (let spent = 0; spent < ms; spent += 20) {
        clock.advance(20);
        frameAt = clock.now();
        onFrame({ atMs: frameAt, rms });
      }
    },
    settle: async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    },
    setVisible: (next, silent = false) => {
      visible = next;
      if (!silent) for (const listener of visibilityListeners) listener(next);
    },
    signal: signal => replyListener?.(signal),
    sendResult,
    releaseSend: outcome => releaseSend(outcome),
    tickets,
    sealed,
    composer,
    startQueuedSend: (index = 0) => queuedStarts[index]?.(),
    lock,
    typed,
    lockControl,
    answerLock: async (index, granted) => {
      lockAnswers[index]?.(granted);
      await rigResult.settle();
    },
    wake,
    meterOpen,
    openMeter: () => pendingMeter?.(),
    get meterReleased() {
      return meterReleased;
    },
    speaker,
  } as Rig;
  return rigResult;
};

/** Start and open: tap, permission granted, listening. */
const listening = async (options?: Parameters<typeof rig>[0]): Promise<Rig> => {
  const r = rig(options);
  r.runner.start();
  await r.settle();
  return r;
};

/** One spoken sentence then a pause long enough to end the turn; leaves the machine in `sending`. */
const speakTurn = async (r: Rig): Promise<void> => {
  r.talk(LOUD, 600);
  await r.settle();
  r.talk(QUIET, 1_520);
  await r.settle();
};

describe('LiveRunner — one whole turn', () => {
  it('opens the microphone from the tap, hears a turn, shows the words, counts down, sends, waits, and listens again', async () => {
    const r = rig();
    r.runner.start();
    // The microphone opens inside the tap, before anything is awaited.
    should(r.log).deepEqual(['lock.acquire', 'take.start']);
    should(r.runner.state.phase).equal('starting');
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.clock.live).equal(1); // the ten-minute idle timer
    r.listeners[0]?.onLive('fix the bug');
    r.talk(LOUD, 600);
    should(r.runner.state.phase).equal('hearing');
    r.listeners[0]?.onLive('fix the bug now');
    should(r.runner.state.words).equal('fix the bug now');
    r.talk(QUIET, 1_520);
    should(r.runner.state.phase).equal('sending');
    await r.settle();
    should(r.takes[0]?.endTurns).equal(1);
    // The preview, then the final words.
    should(r.shown).deepEqual(['fix the bug now', 'Fix the bug.']);
    // The ring finishes 1.5 s after the turn ended; the words have been visible since then.
    r.clock.advance(1_500);
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.takes[0]?.cancelled).be.true();
    should(r.runner.state.phase).equal('working');
    should(r.turns.length).equal(1);
    should(r.log).containEql('reply.watch');
    r.signal({ kind: 'working' });
    r.signal({ kind: 'done' });
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.takes.length).equal(2);
    should(r.log).containEql('reply.stop');
  });

  it('keeps level bars, newest last, capped, and forgets them when the microphone closes', async () => {
    const r = await listening();
    r.talk(LOUD, 20 * (LEVEL_HISTORY + 8));
    const bars = r.runner.levels();
    should(bars.length).equal(LEVEL_HISTORY);
    should(Math.max(...bars)).be.belowOrEqual(1);
    should(bars.at(-1)).be.above(0.5);
    r.runner.hold();
    should(r.runner.levels()).deepEqual([]);
  });

  it('tells subscribers after every event, and not after they leave', async () => {
    const r = rig();
    let calls = 0;
    const off = r.runner.subscribe(() => {
      calls += 1;
    });
    r.runner.start();
    await r.settle();
    should(calls).be.above(1);
    off();
    const seen = calls;
    r.runner.hold();
    should(calls).equal(seen);
  });

  it('reads the clock for the countdown ring', () => {
    const r = rig();
    r.clock.advance(1_234);
    should(r.runner.now()).equal(1_234);
  });
});

describe('LiveRunner — races', () => {
  it('voice returning during the ring cancels the send and the early finish', async () => {
    const r = await listening();
    await speakTurn(r);
    should(r.runner.state.phase).equal('sending');
    r.talk(LOUD, 300); // the voice is back, past the 200 ms a speech start needs
    await r.settle();
    should(r.runner.state.phase).equal('hearing');
    should(r.takes[0]?.resumes).equal(1);
    // The ring would have finished by now; nothing is sent.
    r.clock.advance(2_000);
    await r.settle();
    should(r.sends.length).equal(0);
    should(r.takes.length).equal(1);
  });

  it('a late answer from the cancelled early finish is ignored', async () => {
    const r = await listening();
    let answer: (outcome: TakeOutcome) => void = () => undefined;
    const take = r.takes[0] as FakeTake;
    take.outcome = new Promise(resolve => {
      answer = resolve;
    });
    await speakTurn(r);
    r.talk(LOUD, 300);
    await r.settle();
    answer({ kind: 'words', text: 'stale words', raw: 'stale', cleaned: false });
    await r.settle();
    should(r.shown).not.containEql('stale words');
    should(r.runner.state.phase).equal('hearing');
  });

  it('a short burst after the voice came back ends the turn again and finishes the send', async () => {
    const r = await listening();
    await speakTurn(r);
    r.talk(LOUD, 240); // speech starts (200 ms) → back to hearing, then too short to count
    r.talk(QUIET, 400);
    await r.settle();
    should(r.runner.state.phase).equal('sending');
    r.clock.advance(1_500);
    await r.settle();
    should(r.sends.length).equal(1);
  });

  it('typing while the words are being worked out holds with them on screen', async () => {
    const r = await listening();
    const take = r.takes[0] as FakeTake;
    let answer: (outcome: TakeOutcome) => void = () => undefined;
    take.outcome = new Promise(resolve => {
      answer = resolve;
    });
    await speakTurn(r);
    r.runner.typing();
    answer({ kind: 'words', text: 'Fix the bug.', raw: 'fix', cleaned: false });
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.runner.state.holdReason).equal('typing');
    should(r.shown.at(-1)).equal('Fix the bug.');
    should(take.cancelled).be.true();
    r.clock.advance(5_000);
    should(r.sends.length).equal(0);
  });

  it('Hold stops the countdown; Resume listens again; the words stay', async () => {
    const r = await listening();
    await speakTurn(r);
    await r.settle();
    r.runner.hold();
    should(r.runner.state.phase).equal('hold');
    r.clock.advance(5_000);
    should(r.sends.length).equal(0);
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.shown).not.containEql('<cleared>');
  });

  it('Send now sends at once from a hold', async () => {
    const r = await listening();
    await speakTurn(r);
    await r.settle();
    r.runner.hold();
    r.runner.sendNow();
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.runner.state.phase).equal('working');
  });

  it('a hidden tab pauses; Resume Live needs the tab back, then listens with the locks re-acquired', async () => {
    const r = await listening();
    r.talk(LOUD, 400);
    r.setVisible(false);
    // What was said is kept: the words are worked out first, then the phase pauses and the take closes.
    await r.settle();
    should(r.runner.state.phase).equal('paused');
    should(r.takes[0]?.cancelled).be.true();
    r.runner.resume();
    should(r.runner.state.phase).equal('paused');
    r.setVisible(true);
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.takes.length).equal(2);
  });

  it('a microphone closed while its permission was pending is never reopened', async () => {
    const r = rig();
    r.meterOpen.mode = 'pending';
    r.runner.start();
    await r.settle();
    should(r.runner.state.phase).equal('starting');
    r.runner.end();
    r.openMeter();
    await r.settle();
    should(r.runner.state.phase).equal('off');
    should(r.meterReleased).equal(1);
  });
});

/** The words/empty/failed answers a pending transcription can come to. */
const OUTCOMES: readonly (readonly [string, TakeOutcome])[] = [
  ['words', { kind: 'words', text: 'Fix the bug.', raw: 'fix the bug', cleaned: true }],
  ['nothing', { kind: 'empty' }],
  ['a failure', { kind: 'failed', block: 'engine-failed' }],
];

describe('LiveRunner — a stop is sticky (THE SURPRISE-SEND RULE, with the real endpointer)', () => {
  const STOPS: readonly (readonly [string, (r: Rig) => void, 'hold' | 'paused'])[] = [
    ['Hold', r => r.runner.hold(), 'hold'],
    ['typing', r => r.runner.typing(), 'hold'],
    ['a hidden tab', r => r.setVisible(false), 'paused'],
  ];

  for (const [name, stop, landing] of STOPS) {
    for (const [outcomeName, outcome] of OUTCOMES) {
      it(`${name} while the words are worked out: capture stops now, renewed speech and a second pause cannot undo it, and ${outcomeName} lands on ${landing}`, async () => {
        const r = await listening();
        const take = r.takes[0] as FakeTake;
        let answer: (outcome: TakeOutcome) => void = () => undefined;
        take.outcome = new Promise(resolve => {
          answer = resolve;
        });
        await speakTurn(r);
        should(r.runner.state.phase).equal('sending');
        const metersReleased = r.meterReleased;

        stop(r);
        // Capture and level frames stop IMMEDIATELY; the take stays open so the pending words are not lost.
        should(r.meterReleased).equal(metersReleased + 1);
        should(r.runner.levels()).deepEqual([]);
        should(take.cancelled).be.false();
        // The take's OWN recording closes now too (a decode still pending must not hold the microphone open).
        should(take.stopped).be.true();
        should(r.runner.state.phase).equal('sending');

        // The room speaks again, pauses, speaks again and pauses again: a second pause would auto-send.
        r.talk(LOUD, 900);
        r.talk(QUIET, 1_800);
        r.talk(LOUD, 900);
        r.talk(QUIET, 1_800);
        r.clock.advance(10_000);
        await r.settle();
        should(r.runner.state.phase).equal('sending');
        should(r.runner.state.park).not.equal(null);
        should(r.runner.levels()).deepEqual([]);
        should(take.resumes).equal(0);
        should(take.endTurns).equal(1);
        should(r.sends.length).equal(0);

        answer(outcome);
        await r.settle();
        r.talk(LOUD, 900);
        r.talk(QUIET, 1_800);
        r.clock.advance(10_000);
        await r.settle();

        // It lands where the person put it, never back on listening, never a send, never a reopened engine.
        should(r.runner.state.phase).equal(landing);
        should(r.runner.state.park).equal(null);
        should(r.sends.length).equal(0);
        should(r.takes.length).equal(1);
        should(take.cancelled).be.true();
        should(r.log.filter(entry => entry === 'take.start').length).equal(1);
        should(r.clock.live).equal(0);
        if (outcome.kind === 'words') should(r.shown.at(-1)).equal('Fix the bug.');
        else should(r.shown.at(-1)).equal('<cleared>');
        if (outcome.kind === 'failed')
          should(r.runner.state.notice).deepEqual({ kind: 'take-failed', block: 'engine-failed' });
      });
    }
  }

  it('Resume after a stop that waited for the words listens again, and nothing was sent', async () => {
    const r = await listening();
    const take = r.takes[0] as FakeTake;
    let answer: (outcome: TakeOutcome) => void = () => undefined;
    take.outcome = new Promise(resolve => {
      answer = resolve;
    });
    await speakTurn(r);
    r.runner.hold();
    answer({ kind: 'empty' });
    await r.settle();
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.sends.length).equal(0);
  });
});

describe('LiveRunner — a stop in the middle of a spoken turn keeps what was said', () => {
  const STOPS: readonly (readonly [string, (r: Rig) => void, 'hold' | 'paused'])[] = [
    ['Hold', r => r.runner.hold(), 'hold'],
    ['typing', r => r.runner.typing(), 'hold'],
    ['a hidden tab', r => r.setVisible(false), 'paused'],
  ];

  for (const [name, stop, landing] of STOPS) {
    it(`${name} before the pause: capture closes now, the words are worked out and put in the box, then it lands on ${landing}`, async () => {
      const r = await listening();
      const take = r.takes[0] as FakeTake;
      let answer: (outcome: TakeOutcome) => void = () => undefined;
      take.outcome = new Promise(resolve => {
        answer = resolve;
      });
      r.talk(LOUD, 600);
      await r.settle();
      should(r.runner.state.phase).equal('hearing');
      const metersReleased = r.meterReleased;

      stop(r);
      should(r.runner.state.phase).equal('sending');
      should(r.meterReleased).equal(metersReleased + 1);
      should(take.stopped).be.true();
      should(take.cancelled).be.false();
      should(take.endTurns).equal(1);
      should(r.runner.state.countdown).equal(null);
      should(r.clock.live).equal(0);

      // Nothing the room says afterwards does anything.
      r.talk(LOUD, 900);
      r.talk(QUIET, 1_800);
      r.clock.advance(10_000);
      await r.settle();
      should(r.sends.length).equal(0);
      should(take.endTurns).equal(1);

      answer({ kind: 'words', text: 'Fix the bug.', raw: 'fix the bug', cleaned: true });
      await r.settle();
      should(r.runner.state.phase).equal(landing);
      should(r.shown.at(-1)).equal('Fix the bug.');
      should(take.cancelled).be.true();
      should(r.sends.length).equal(0);
      should(r.clock.live).equal(0);
    });
  }

  it('Hold before the pause with an engine that finds no words lands On hold with the box untouched', async () => {
    const r = await listening();
    const take = r.takes[0] as FakeTake;
    take.outcome = Promise.resolve({ kind: 'empty' });
    r.talk(LOUD, 600);
    await r.settle();
    r.runner.hold();
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.shown.at(-1)).not.equal('Fix the bug.');
    should(r.sends.length).equal(0);
  });
});

describe('LiveRunner — typing pauses auto-send for good (THE SURPRISE-SEND RULE)', () => {
  const sendFirstTurn = async (r: Rig): Promise<void> => {
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.runner.state.phase).equal('working');
  };

  it('typing while the ferret works holds Live when the reply lands: the mic stays shut, room speech sends nothing, Resume listens', async () => {
    const r = await listening();
    await sendFirstTurn(r);
    r.runner.typing();
    should(r.runner.state.phase).equal('working');
    r.signal({ kind: 'done' });
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.runner.state.holdReason).equal('typing');
    should(r.takes.length).equal(1);
    // Room speech has no microphone to reach, and no timer is left to send.
    r.talk(LOUD, 900);
    r.talk(QUIET, 1_800);
    r.clock.advance(10_000);
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.runner.state.phase).equal('hold');
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.takes.length).equal(2);
  });

  it('typing while the microphone and the lock are still being opened holds Live: nothing listens or sends on readiness', async () => {
    const r = rig();
    r.lockControl.pending = true;
    r.runner.start();
    await r.settle();
    r.runner.typing();
    should(r.runner.state.phase).equal('hold');
    should(r.takes[0]?.cancelled).be.true();
    await r.answerLock(0, true);
    r.talk(LOUD, 900);
    r.talk(QUIET, 1_800);
    r.clock.advance(10_000);
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.sends.length).equal(0);
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
  });

  it('a typing hold whose lock is still unanswered asks again on Resume, and the late answer is the one that counts', async () => {
    const r = rig();
    r.lockControl.pending = true;
    r.runner.start();
    await r.settle();
    r.runner.typing();
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('starting');
    await r.answerLock(0, true);
    should(r.runner.state.phase).equal('listening');
  });

  it('text in the box that Live did not put there is never sent by itself: the turn ends On hold with its words in the box', async () => {
    const r = await listening();
    r.typed.current = 'UNFINISHED typed instruction';
    await speakTurn(r);
    should(r.runner.state.countdown).equal(null);
    r.clock.advance(10_000);
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.shown.at(-1)).equal('Fix the bug.');
    should(r.sends.length).equal(0);
    should(r.clock.live).equal(0);
  });

  it('an engine that ends the take by itself while typed text is in the box also holds', async () => {
    const r = await listening();
    r.typed.current = 'draft';
    r.talk(LOUD, 600);
    await r.settle();
    r.listeners[0]?.onEnded();
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.sends.length).equal(0);
  });

  it('whitespace in the box is not text', async () => {
    const r = await listening();
    r.typed.current = '  \n ';
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.sends.length).equal(1);
  });
});

describe('LiveRunner — the one-tab lock', () => {
  const pendingRig = (): Rig => {
    const r = rig();
    r.lockControl.pending = true;
    return r;
  };
  const watchPhases = (r: Rig): string[] => {
    const phases: string[] = [];
    r.runner.subscribe(() => void phases.push(r.runner.state.phase));
    return phases;
  };
  const releases = (r: Rig): number => r.log.filter(entry => entry === 'lock.release').length;

  it('does not listen until the lock is granted, even when the microphone is ready first', async () => {
    const r = pendingRig();
    const phases = watchPhases(r);
    r.runner.start();
    await r.settle();
    should(r.runner.state.phase).equal('starting');
    should(phases).not.containEql('listening');
    await r.answerLock(0, true);
    should(r.runner.state.phase).equal('listening');
  });

  it('a lock refused after the microphone was ready ends Live: the second tab never listens, hears or sends', async () => {
    const r = pendingRig();
    const phases = watchPhases(r);
    r.runner.start();
    await r.settle();
    r.talk(LOUD, 1_000);
    r.talk(QUIET, 2_000);
    await r.answerLock(0, false);
    should(r.runner.state.phase).equal('off');
    should(r.runner.state.notice).deepEqual({ kind: 'blocked', block: 'other-tab' });
    should(phases).not.containEql('listening');
    should(phases).not.containEql('hearing');
    should(phases).not.containEql('sending');
    should(r.takes[0]?.cancelled).be.true();
    should(r.meterReleased).equal(1);
    should(r.sends.length).equal(0);
  });

  it('a refusal ends Live in every active phase', async () => {
    const setups: readonly (readonly [string, (r: Rig) => Promise<void>])[] = [
      ['listening', async () => undefined],
      ['hearing', async r => r.talk(LOUD, 600)],
      ['sending', speakTurn],
      [
        'hold',
        async r => {
          r.runner.hold();
        },
      ],
      [
        'paused',
        async r => {
          r.setVisible(false);
        },
      ],
    ];
    for (const [name, setup] of setups) {
      const r = await listening();
      await setup(r);
      r.runner.dispatch({ type: 'locks', granted: false });
      await r.settle();
      should([name, r.runner.state.phase]).deepEqual([name, 'off']);
      should(r.runner.state.notice).deepEqual({ kind: 'blocked', block: 'other-tab' });
    }
  });

  it('End while the lock is pending: the late grant is handed straight back and Live stays off', async () => {
    const r = pendingRig();
    r.runner.start();
    await r.settle();
    r.runner.end();
    const before = releases(r);
    await r.answerLock(0, true);
    should(r.runner.state.phase).equal('off');
    should(releases(r)).equal(before + 1);
    should(r.takes.length).equal(1);
  });

  it('dispose while the lock is pending: the late grant is handed straight back', async () => {
    const r = pendingRig();
    r.runner.start();
    await r.settle();
    r.runner.dispose();
    const before = releases(r);
    await r.answerLock(0, true);
    should(releases(r)).equal(before + 1);
  });

  it('a late refusal after End changes nothing and releases nothing more', async () => {
    const r = pendingRig();
    r.runner.start();
    await r.settle();
    r.runner.end();
    const before = releases(r);
    await r.answerLock(0, false);
    should(r.runner.state.phase).equal('off');
    should(r.runner.state.notice).equal(null);
    should(releases(r)).equal(before);
  });

  it("a start right after End: the old ask's grant is ignored and does not release the new ask", async () => {
    const r = pendingRig();
    r.runner.start();
    await r.settle();
    r.runner.end();
    r.runner.start();
    await r.settle();
    should(r.log.filter(entry => entry === 'lock.acquire').length).equal(2);
    const before = releases(r);
    await r.answerLock(0, true);
    should(r.runner.state.phase).equal('starting');
    should(releases(r)).equal(before);
    await r.answerLock(1, true);
    should(r.runner.state.phase).equal('listening');
  });

  it('a stale grant does not release a lock the new Live already holds', async () => {
    const r = pendingRig();
    r.runner.start();
    await r.settle();
    r.runner.end();
    r.lockControl.pending = false;
    r.runner.start();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    const before = releases(r);
    await r.answerLock(0, true);
    should(r.runner.state.phase).equal('listening');
    should(releases(r)).equal(before);
  });

  it('hidden while the lock is pending: it stays paused, a late refusal ends it, a grant is kept for Resume', async () => {
    const refused = pendingRig();
    refused.runner.start();
    await refused.settle();
    refused.setVisible(false);
    should(refused.runner.state.phase).equal('paused');
    await refused.answerLock(0, false);
    should(refused.runner.state.phase).equal('off');
    should(refused.runner.state.notice).deepEqual({ kind: 'blocked', block: 'other-tab' });

    const granted = pendingRig();
    granted.runner.start();
    await granted.settle();
    granted.setVisible(false);
    await granted.answerLock(0, true);
    should(granted.runner.state.phase).equal('paused');
    granted.setVisible(true);
    granted.runner.resume();
    await granted.settle();
    should(granted.runner.state.phase).equal('listening');
    should(granted.log.filter(entry => entry === 'lock.acquire').length).equal(1);
  });

  it('Resume Live from a pause waits for a pending lock before it listens', async () => {
    const r = pendingRig();
    r.runner.start();
    await r.settle();
    r.setVisible(false);
    r.setVisible(true);
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('starting');
    await r.answerLock(0, true);
    should(r.runner.state.phase).equal('listening');
  });
});

describe('LiveRunner — the reply is watched from BEFORE the send', () => {
  const snapshot = (turnState: ReplySnapshot['turnState'], turnStateAt: string, status = 'running'): ReplySnapshot => ({
    turnState,
    turnStateAt,
    status,
  });
  const session = (first: ReplySnapshot) => {
    let current: ReplySnapshot = first;
    const listeners = new Set<() => void>();
    const api: ReplySource = {
      current: () => current,
      subscribe: listener => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    return {
      api,
      set: (next: ReplySnapshot) => {
        current = next;
        for (const listener of [...listeners]) listener();
      },
      listeners,
    };
  };

  it('arms the feed before the message goes', async () => {
    const r = await listening();
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.log.indexOf('reply.arm')).be.above(-1);
    should(r.log.indexOf('reply.arm')).be.below(r.log.indexOf('send'));
    should(r.log.indexOf('send')).be.below(r.log.indexOf('reply.watch'));
  });

  it('a turn that finishes while the send is still being acknowledged is not lost: Live listens again, not Working forever', async () => {
    const fake = session(snapshot('your-turn', 't1'));
    const r = rig({ reply: sessionReplyFeed(fake.api) });
    r.sendResult.current = 'pending';
    r.runner.start();
    await r.settle();
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.runner.state.sendInFlight).be.true();
    // The ferret takes the turn and finishes it, all inside the send's await.
    fake.set(snapshot('working', 't2'));
    fake.set(snapshot('your-turn', 't3'));
    r.releaseSend({ kind: 'sent', sentAtMs: 0 });
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.takes.length).equal(2);
    should(fake.listeners.size).equal(0);
  });

  it('a failed send cancels the armed feed and watches nothing', async () => {
    const r = await listening();
    r.sendResult.current = { kind: 'failed', reason: 'offline' };
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.log).containEql('reply.cancel');
    should(r.log).not.containEql('reply.watch');
  });

  it('ending Live while the send is pending cancels the armed feed, and the late ack watches nothing', async () => {
    const r = await listening();
    r.sendResult.current = 'pending';
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    r.runner.end();
    should(r.log).containEql('reply.cancel');
    r.releaseSend({ kind: 'sent', sentAtMs: 0 });
    await r.settle();
    should(r.log).not.containEql('reply.watch');
    should(r.runner.state.phase).equal('off');
  });
});

describe('LiveRunner — time', () => {
  it('waits for slow words after the ring, shows them for the settle time, then sends', async () => {
    const r = await listening();
    let answer: (outcome: TakeOutcome) => void = () => undefined;
    (r.takes[0] as FakeTake).outcome = new Promise(resolve => {
      answer = resolve;
    });
    await speakTurn(r);
    r.clock.advance(2_000);
    await r.settle();
    should(r.sends.length).equal(0);
    answer({ kind: 'words', text: 'Fix the bug.', raw: 'fix', cleaned: false });
    await r.settle();
    r.clock.advance(499);
    await r.settle();
    should(r.sends.length).equal(0);
    r.clock.advance(1);
    await r.settle();
    should(r.sends.length).equal(1);
  });

  it('ends Live after ten minutes with no speech', async () => {
    const r = await listening();
    r.clock.advance(600_000);
    should(r.runner.state.phase).equal('off');
    should(r.runner.state.notice).deepEqual({ kind: 'ended', why: 'idle' });
  });
});

describe('LiveRunner — a turn that comes to nothing, and a send that fails', () => {
  it('goes back to listening on an empty take, clearing the preview, and records the turn nowhere', async () => {
    const r = await listening();
    (r.takes[0] as FakeTake).outcome = Promise.resolve({ kind: 'empty' });
    await speakTurn(r);
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.shown.at(-1)).equal('<cleared>');
    should(r.takes[0]?.resumes).equal(1);
    should(r.turns.length).equal(0);
  });

  it('goes back to listening with a notice when the engine failed', async () => {
    const r = await listening();
    (r.takes[0] as FakeTake).outcome = Promise.resolve({ kind: 'failed', block: 'engine-failed' });
    await speakTurn(r);
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.runner.state.notice).deepEqual({ kind: 'take-failed', block: 'engine-failed' });
  });

  it('stays On hold when the send fails, with the words kept', async () => {
    const r = await listening();
    r.sendResult.current = { kind: 'failed', reason: 'offline' };
    await speakTurn(r);
    await r.settle();
    r.clock.advance(1_500);
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.runner.state.holdReason).equal('send-failed');
    should(r.shown.at(-1)).equal('Fix the bug.');
    should(r.sends.length).equal(1);
    // Nothing is retried by itself.
    r.clock.advance(10_000);
    await r.settle();
    should(r.sends.length).equal(1);
  });

  it('ignores a send that finishes after Live was disposed', async () => {
    const r = await listening();
    r.sendResult.current = 'pending';
    await speakTurn(r);
    await r.settle();
    r.clock.advance(1_500);
    await r.settle();
    should(r.runner.state.sendInFlight).be.true();
    r.runner.dispose();
    r.releaseSend({ kind: 'sent', sentAtMs: 1 });
    await r.settle();
    should(r.runner.state.phase).equal('sending');
  });
});

describe('LiveRunner — what the ferret does', () => {
  const working = async (r: Rig): Promise<void> => {
    await speakTurn(r);
    await r.settle();
    r.clock.advance(1_500);
    await r.settle();
  };

  it('a question holds Live', async () => {
    const r = await listening();
    await working(r);
    r.signal({ kind: 'needs-input' });
    should(r.runner.state.holdReason).equal('needs-input');
  });

  it('the ferret stopping ends Live with nothing open', async () => {
    const r = await listening();
    await working(r);
    r.signal({ kind: 'ended' });
    should(r.runner.state.phase).equal('off');
    should(r.log).containEql('lock.release');
  });

  it('with a speaker the reply is read, then Live listens; a tap skips it', async () => {
    const r = await listening({ speaker: true });
    await working(r);
    r.signal({ kind: 'done' });
    should(r.runner.state.phase).equal('reading');
    should(r.speaker.spoke).equal(1);
    r.speaker.done();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    await working(r);
    r.signal({ kind: 'done' });
    r.runner.skip();
    should(r.speaker.stopped).be.above(0);
    await r.settle();
    should(r.runner.state.phase).equal('listening');
  });
});

describe('LiveRunner — refusals', () => {
  it('refuses a device that cannot send', () => {
    const r = rig({ canSend: false });
    r.runner.start();
    should(r.runner.state.phase).equal('off');
    should(r.log).deepEqual([]);
  });

  it('refuses when another tab is Live', async () => {
    const r = rig();
    r.lock.granted = false;
    r.runner.start();
    await r.settle();
    should(r.runner.state.phase).equal('off');
    should(r.runner.state.notice).deepEqual({ kind: 'blocked', block: 'other-tab' });
    should(r.takes[0]?.cancelled).be.true();
  });

  it('refuses when the microphone cannot be measured, or the meter throws', async () => {
    for (const mode of ['null', 'reject'] as const) {
      const r = rig();
      r.meterOpen.mode = mode;
      r.runner.start();
      await r.settle();
      should(r.runner.state.phase).equal('off');
      should(r.runner.state.notice).deepEqual({ kind: 'blocked', block: 'mic-blocked' });
    }
  });

  it('refuses when the engine says it cannot run', async () => {
    const r = rig();
    r.runner.start();
    r.listeners[0]?.onFailed('engine-missing');
    await r.settle();
    should(r.runner.state.notice).deepEqual({ kind: 'blocked', block: 'engine-missing' });
  });

  it('keeps working when the screen wake lock is refused, and says so', async () => {
    const r = rig();
    r.wake.granted = false;
    r.runner.start();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.runner.screenMayTurnOff).be.true();
  });

  it('a restart in the same tab does not ask the mic lock twice', async () => {
    const r = await listening();
    r.runner.hold();
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    r.setVisible(false);
    r.setVisible(true);
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
  });
});

describe('LiveRunner — the engine ends a take by itself', () => {
  it('while hearing, that ends the turn like the maximum length does', async () => {
    const r = await listening();
    r.talk(LOUD, 600);
    r.listeners[0]?.onEnded();
    should(r.runner.state.phase).equal('sending');
    should(r.runner.state.endReason).equal('max-turn');
  });

  it('while listening, recording simply carries on; when it cannot, Live ends', async () => {
    const r = await listening();
    r.listeners[0]?.onEnded();
    await r.settle();
    should(r.takes[0]?.resumes).equal(1);
    should(r.runner.state.phase).equal('listening');
    (r.takes[0] as FakeTake).resumeResult = false;
    r.listeners[0]?.onEnded();
    await r.settle();
    should(r.runner.state.phase).equal('off');
  });

  it('ignores anything a closed take says afterwards', async () => {
    const r = await listening();
    const listener = r.listeners[0] as TakeListener;
    r.runner.hold();
    listener.onLive('late');
    listener.onEnded();
    listener.onFailed('engine-failed');
    should(r.runner.state.phase).equal('hold');
  });
});

describe('LiveRunner — dispose', () => {
  it('closes everything and ignores every event afterwards', async () => {
    const r = await listening();
    r.talk(LOUD, 600);
    r.runner.dispose();
    should(r.takes[0]?.cancelled).be.true();
    should(r.meterReleased).equal(1);
    should(r.log).containEql('lock.release');
    const phase = r.runner.state.phase;
    r.runner.dispatch({ type: 'end' } as LiveEvent);
    r.setVisible(false);
    should(r.runner.state.phase).equal(phase);
    should(r.clock.live).equal(0);
  });

  it('stops a reading and a reply watch', async () => {
    const r = await listening({ speaker: true });
    await speakTurn(r);
    await r.settle();
    r.clock.advance(1_500);
    await r.settle();
    r.signal({ kind: 'done' });
    r.runner.dispose();
    should(r.speaker.stopped).be.above(0);
  });
});

describe('LiveRunner — ONE REVOCABLE SEND PATH (the approved words, taken back until the composer starts them)', () => {
  /** A turn ended and its countdown ran out: the send is approved and queued, the composer has not started it. */
  const queued = async (r: Rig): Promise<void> => {
    r.composer.queued = true;
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.runner.state.phase).equal('sending');
    should(r.runner.state.sendInFlight).be.true();
    should(r.tickets.length).equal(1);
  };

  it('hands the composer a ticket with exactly the words on screen when the send was approved', async () => {
    const r = await listening();
    await queued(r);
    const ticket = r.tickets[0] as SendTicket;
    should(ticket.text).equal('Fix the bug.');
    should(ticket.revoked).be.false();
    r.startQueuedSend();
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.runner.state.phase).equal('working');
  });

  const STOPS: readonly (readonly [string, (r: Rig) => void, 'hold' | 'paused'])[] = [
    ['typing', r => r.runner.typing(), 'hold'],
    ['Hold', r => r.runner.hold(), 'hold'],
    ['a hidden tab', r => r.setVisible(false), 'paused'],
  ];
  for (const [name, stop, landing] of STOPS) {
    it(`${name} before the composer starts the send takes it back: it lands on ${landing}, the words stay, NOTHING is sent`, async () => {
      const r = await listening();
      await queued(r);
      stop(r);
      should(r.runner.state.phase).equal(landing);
      should(r.tickets[0]?.revoked).be.true();
      should(r.takes[0]?.cancelled).be.true();
      should(r.log).containEql('reply.cancel');
      // The composer's render lands afterwards: the ticket is dead, the send does not start.
      r.startQueuedSend();
      await r.settle();
      r.clock.advance(60_000);
      await r.settle();
      should(r.sends).deepEqual([]);
      should(r.runner.state.phase).equal(landing);
      should(r.runner.state.words).equal('Fix the bug.');
    });
  }

  it('End before the composer starts the send: Live is off and the send never starts', async () => {
    const r = await listening();
    await queued(r);
    r.runner.end();
    should(r.runner.state.phase).equal('off');
    should(r.tickets[0]?.revoked).be.true();
    r.startQueuedSend();
    await r.settle();
    should(r.sends).deepEqual([]);
    should(r.runner.state.phase).equal('off');
  });

  it('the page leaving revokes the queued send too', async () => {
    const r = await listening();
    await queued(r);
    r.runner.dispose();
    should(r.tickets[0]?.revoked).be.true();
    r.startQueuedSend();
    await r.settle();
    should(r.sends).deepEqual([]);
  });

  it('a hidden tab whose event has not arrived yet is still refused at the commit', async () => {
    const r = await listening();
    await queued(r);
    r.setVisible(false, true);
    r.startQueuedSend();
    await r.settle();
    should(r.sends).deepEqual([]);
    // The composer said "not sent": the words are On hold, kept.
    should(r.runner.state.phase).equal('hold');
    should(r.runner.state.holdReason).equal('send-failed');
  });

  it('a send the composer already started is on the wire: a stop does not take it back and the answer still counts', async () => {
    const r = await listening();
    r.sendResult.current = 'pending';
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.tickets[0]?.revoked).be.false();
    r.runner.typing();
    r.runner.hold();
    r.setVisible(false);
    should(r.tickets[0]?.revoked).be.false();
    should(r.runner.state.phase).equal('sending');
    r.releaseSend({ kind: 'sent', sentAtMs: 1 });
    await r.settle();
    should(r.runner.state.phase).equal('working');
    should(r.sends.length).equal(1);
  });

  it('a taken-back send that fails late cannot fail the NEXT send', async () => {
    const r = await listening();
    await queued(r);
    r.runner.hold();
    r.runner.resume();
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.tickets.length).equal(2);
    should(r.runner.state.sendInFlight).be.true();
    // The first, revoked one answers "not sent" now: it is nobody's any more.
    r.startQueuedSend(0);
    await r.settle();
    should(r.runner.state.phase).equal('sending');
    should(r.runner.state.sendInFlight).be.true();
    r.startQueuedSend(1);
    await r.settle();
    should(r.sends.length).equal(1);
    should(r.runner.state.phase).equal('working');
  });

  it('a send the composer refuses is On hold with the words kept', async () => {
    const r = await listening();
    r.sendResult.current = { kind: 'failed', reason: 'not-sent' };
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.runner.state.holdReason).equal('send-failed');
  });
});

describe("LiveRunner — the person pressing the composer's own Send retires the attempt", () => {
  const pressSend = (r: Rig, outcome: Promise<boolean> = Promise.resolve(true)): void => r.runner.personSent(outcome);

  it('during a slow decode: the preview goes ONCE, the countdown and the pending take are gone, the mic is off, and Live watches the reply', async () => {
    const r = await listening();
    const take = r.takes[0] as FakeTake;
    let answer: (outcome: TakeOutcome) => void = () => undefined;
    take.outcome = new Promise(resolve => {
      answer = resolve;
    });
    r.listeners[0]?.onLive('fix the bug');
    await speakTurn(r);
    should(r.runner.state.phase).equal('sending');
    should(r.runner.state.countdown).not.equal(null);

    pressSend(r);
    await r.settle();
    should(r.runner.state.phase).equal('working');
    should(take.cancelled).be.true();
    should(r.clock.live).equal(0);
    should(r.log).containEql('reply.arm');
    should(r.log).containEql('reply.watch');
    should(r.turns.length).equal(1);

    // The slow decode finally answers, and the countdown would have finished: neither puts anything on screen or sends.
    answer({ kind: 'words', text: 'Fix the bug.', raw: 'fix the bug', cleaned: true });
    r.clock.advance(60_000);
    await r.settle();
    should(r.sends).deepEqual([]);
    should(r.shown).deepEqual(['fix the bug']);
    should(r.runner.state.phase).equal('working');
    // The first real turn: the microphone opens again only when the ferret is done.
    should(r.takes.length).equal(1);
    r.signal({ kind: 'done' });
    await r.settle();
    should(r.runner.state.phase).equal('listening');
    should(r.takes.length).equal(2);
  });

  it('from every phase before a send, and not while the ferret works or reads', async () => {
    const heard = await listening();
    heard.talk(LOUD, 600);
    should(heard.runner.state.phase).equal('hearing');
    pressSend(heard);
    await heard.settle();
    should(heard.runner.state.phase).equal('working');
    should(heard.takes[0]?.cancelled).be.true();

    const typing = await listening();
    typing.runner.typing();
    should(typing.runner.state.phase).equal('hold');
    pressSend(typing);
    await typing.settle();
    should(typing.runner.state.phase).equal('working');

    const starting = rig();
    starting.runner.start();
    pressSend(starting);
    await starting.settle();
    should(starting.runner.state.phase).equal('working');
    should(starting.takes[0]?.cancelled).be.true();

    const hidden = await listening();
    hidden.setVisible(false);
    should(hidden.runner.state.phase).equal('paused');
    pressSend(hidden);
    await hidden.settle();
    should(hidden.runner.state.phase).equal('working');

    // The ferret is working: a second message is the person's own business, Live changes nothing.
    const working = await listening();
    await speakTurn(working);
    working.clock.advance(1_500);
    await working.settle();
    should(working.runner.state.phase).equal('working');
    const before = working.runner.state;
    pressSend(working);
    should(working.runner.state).equal(before);

    const reading = await listening({ speaker: true });
    await speakTurn(reading);
    reading.clock.advance(1_500);
    await reading.settle();
    reading.signal({ kind: 'done' });
    should(reading.runner.state.phase).equal('reading');
    const readState = reading.runner.state;
    pressSend(reading);
    should(reading.runner.state).equal(readState);

    const off = rig();
    pressSend(off);
    should(off.runner.state.phase).equal('off');
    should(off.log).deepEqual([]);
  });

  it('a press that fails is On hold with the words kept, and Live never sends them itself', async () => {
    const r = await listening();
    await speakTurn(r);
    await r.settle();
    pressSend(r, Promise.resolve(false));
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    should(r.runner.state.holdReason).equal('send-failed');
    should(r.log).containEql('reply.cancel');
    r.clock.advance(60_000);
    await r.settle();
    should(r.sends).deepEqual([]);
  });

  it('a send Live queued but the composer has not started gives way to the press: one message, not two', async () => {
    const r = await listening();
    r.composer.queued = true;
    await speakTurn(r);
    r.clock.advance(1_500);
    await r.settle();
    should(r.tickets.length).equal(1);
    pressSend(r);
    should(r.tickets[0]?.revoked).be.true();
    await r.settle();
    should(r.runner.state.phase).equal('working');
    // The composer's deferred render arrives: Live's ticket is dead.
    r.startQueuedSend();
    await r.settle();
    should(r.sends).deepEqual([]);
    should(r.runner.state.phase).equal('working');
  });

  it('a stop while the press is on the wire changes nothing: it already went', async () => {
    const r = await listening();
    await speakTurn(r);
    let finish: (sent: boolean) => void = () => undefined;
    pressSend(
      r,
      new Promise<boolean>(resolve => {
        finish = resolve;
      }),
    );
    r.runner.typing();
    r.runner.hold();
    r.setVisible(false);
    should(r.runner.state.phase).equal('sending');
    finish(true);
    await r.settle();
    should(r.runner.state.phase).equal('working');
  });
});

describe('LiveRunner — a new take never writes over an earlier one', () => {
  it('seals the box when the microphone opens: at the tap, on Resume and when the ferret is done', async () => {
    const r = rig();
    r.runner.start();
    await r.settle();
    should(r.sealed.length).equal(1);
    await speakTurn(r);
    r.runner.hold();
    await r.settle();
    should(r.runner.state.phase).equal('hold');
    r.runner.resume();
    await r.settle();
    should(r.sealed.length).equal(2);
    should(r.takes.length).equal(2);
  });
});
