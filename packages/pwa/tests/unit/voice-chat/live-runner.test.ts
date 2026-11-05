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
  ReplySignal,
  SendOutcome,
  TakeHandle,
  TakeListener,
  TakeOutcome,
} from '../../../src/lib/voice-chat/ports.ts';
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
  setVisible(visible: boolean): void;
  signal(signal: ReplySignal): void;
  sendResult: { current: SendOutcome | 'pending' };
  releaseSend(outcome: SendOutcome): void;
  lock: { granted: boolean };
  wake: { granted: boolean };
  meterOpen: { mode: 'ok' | 'null' | 'reject' | 'pending' };
  openMeter(): void;
  meterReleased: number;
  speaker: { spoke: number; stopped: number; done: () => void };
}

const rig = (options: { speaker?: boolean; canSend?: boolean; graceMs?: unknown } = {}): Rig => {
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
  const sendResult: Rig['sendResult'] = { current: { kind: 'sent', sentAtMs: 0 } };
  let releaseSend: (outcome: SendOutcome) => void = () => undefined;
  const lock = { granted: true };
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
      shown: () => shown.at(-1) ?? '',
      send: () => {
        sends.push(clock.now());
        if (sendResult.current === 'pending')
          return new Promise<SendOutcome>(resolve => {
            releaseSend = resolve;
          });
        return Promise.resolve(sendResult.current);
      },
    },
    reply: {
      watch: listener => {
        replyListener = listener;
        log.push('reply.watch');
        return () => {
          replyListener = null;
          log.push('reply.stop');
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
      acquire: () => Promise.resolve(lock.granted),
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
    setVisible: next => {
      visible = next;
      for (const listener of visibilityListeners) listener(next);
    },
    signal: signal => replyListener?.(signal),
    sendResult,
    releaseSend: outcome => releaseSend(outcome),
    lock,
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
    should(r.log).deepEqual(['take.start']);
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
