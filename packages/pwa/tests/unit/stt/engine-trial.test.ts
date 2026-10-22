/**
 * Proves Try it: it opens one session, records for the trial's length, finishes it, and measures the
 * microphone opening, the first words and the wait after the recording — and that a failure, a hidden
 * page and a cancel each end it with a recognition error and nothing else.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserRecognitionError } from '../../../src/lib/stt/browser-recognition.ts';
import {
  type EngineTrialPorts,
  type EngineTrialUpdate,
  formatSeconds,
  startEngineTrial,
  TRIAL_RECORD_MS,
} from '../../../src/lib/stt/engine-trial.ts';
import type { OnDeviceSession, OnDeviceSessionOptions } from '../../../src/lib/stt/on-device-voice.ts';

class FakeSession implements OnDeviceSession {
  readonly options: OnDeviceSessionOptions;
  started = 0;
  cancelled = 0;
  finishes = 0;
  timings?: () => { readonly loadMs?: number } | undefined;
  resolveFinish: (text: string) => void = () => undefined;
  rejectFinish: (error: unknown) => void = () => undefined;

  constructor(options: OnDeviceSessionOptions) {
    this.options = options;
  }
  start(): void {
    this.started += 1;
  }
  finish(): Promise<string> {
    this.finishes += 1;
    return new Promise((resolve, reject) => {
      this.resolveFinish = resolve;
      this.rejectFinish = reject;
    });
  }
  cancel(): void {
    this.cancelled += 1;
  }
}

const harness = (open?: (options: OnDeviceSessionOptions) => OnDeviceSession) => {
  let clock = 1_000;
  const timers = new Map<number, { callback: () => void; at: number }>();
  let nextTimer = 1;
  const sessions: FakeSession[] = [];
  const updates: EngineTrialUpdate[] = [];
  const ports: EngineTrialPorts = {
    open:
      open ??
      (options => {
        const session = new FakeSession(options);
        sessions.push(session);
        return session;
      }),
    now: () => clock,
    setTimeout: (callback, milliseconds) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, at: clock + milliseconds });
      return id;
    },
    clearTimeout: handle => {
      timers.delete(handle as number);
    },
  };
  const advance = (milliseconds: number): void => {
    clock += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.at > clock) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  return { ports, sessions, updates, advance, timers, onUpdate: (update: EngineTrialUpdate) => updates.push(update) };
};

/** The item at `index`, which the test has just made exist. */
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};

describe('startEngineTrial', () => {
  it('records for the trial length, then measures the open, the first words and the finish', async () => {
    const h = harness();
    const trial = startEngineTrial(h.ports, h.onUpdate);
    const session = at(h.sessions, 0);
    should(session.started).equal(1);
    should(session.options.liveWords).be.true();
    h.advance(300);
    session.options.onStart();
    session.options.onStart();
    h.advance(800);
    session.options.onLive?.({ committed: 'hello', interim: 'there', paused: false });
    h.advance(500);
    session.options.onTranscript('hello there friend');
    session.options.onTranscript('   ');
    h.advance(TRIAL_RECORD_MS - 1_300);
    should(session.finishes).equal(1);
    h.advance(1_200);
    session.resolveFinish('  hello there friend  ');
    should(await trial.result).eql({
      text: 'hello there friend',
      openMs: 300,
      recordedMs: TRIAL_RECORD_MS,
      firstWordMs: 800,
      finishMs: 1_200,
      loadMs: null,
    });
    should(h.updates).eql([
      { phase: 'opening', live: '' },
      { phase: 'recording', live: '' },
      { phase: 'recording', live: 'hello there' },
      { phase: 'recording', live: 'hello there friend' },
      { phase: 'transcribing', live: '' },
    ]);
    trial.cancel();
    should(session.cancelled).equal(0);
  });

  it('says no words arrived early when none did, and stops at the engine’s own limit', async () => {
    const h = harness();
    const trial = startEngineTrial({ ...h.ports, recordMs: 50_000 }, h.onUpdate);
    const session = at(h.sessions, 0);
    session.options.onLimit();
    should(session.finishes).equal(0);
    session.options.onStart();
    h.advance(2_000);
    session.options.onLimit();
    session.options.onLimit();
    should(session.finishes).equal(1);
    should(h.timers.size).equal(0);
    session.timings = () => ({ loadMs: 2_500 });
    session.resolveFinish('');
    const result = await trial.result;
    should(result.firstWordMs).be.null();
    should(result.loadMs).equal(2_500);
  });

  it('ends with the session’s failure, or a plain one for anything else', async () => {
    const h = harness();
    const trial = startEngineTrial(h.ports, h.onUpdate);
    const session = at(h.sessions, 0);
    session.options.onStart();
    h.advance(TRIAL_RECORD_MS);
    session.rejectFinish(new BrowserRecognitionError('bad-audio', 'Too quiet.'));
    await should(trial.result).be.rejectedWith({ code: 'bad-audio', message: 'Too quiet.' });

    const other = harness();
    const second = startEngineTrial(other.ports, other.onUpdate);
    at(other.sessions, 0).options.onStart();
    other.advance(TRIAL_RECORD_MS);
    at(other.sessions, 0).rejectFinish(new Error('boom'));
    await should(second.result).be.rejectedWith({ code: 'recognition-failed' });

    const failing = harness();
    const third = startEngineTrial(failing.ports, failing.onUpdate);
    at(failing.sessions, 0).options.onFailure(new BrowserRecognitionError('permission-denied', 'No microphone.'));
    at(failing.sessions, 0).options.onStart();
    await should(third.result).be.rejectedWith({ code: 'permission-denied' });
    should(failing.timers.size).equal(0);
  });

  it('ends when the page hides and when cancelled, and never measures after', async () => {
    const h = harness();
    const hidden = startEngineTrial(h.ports, h.onUpdate);
    at(h.sessions, 0).options.onStart();
    at(h.sessions, 0).options.onAbort();
    await should(hidden.result).be.rejectedWith({ code: 'aborted' });
    should(h.timers.size).equal(0);

    const c = harness();
    const cancelled = startEngineTrial(c.ports, c.onUpdate);
    const session = at(c.sessions, 0);
    session.options.onStart();
    cancelled.cancel();
    cancelled.cancel();
    should(session.cancelled).equal(1);
    await should(cancelled.result).be.rejectedWith({ code: 'aborted' });
    session.options.onTranscript('late words');
    should(c.updates.at(-1)).eql({ phase: 'recording', live: '' });
  });

  it('drops a finish that lands after a cancel', async () => {
    const h = harness();
    const trial = startEngineTrial(h.ports, h.onUpdate);
    const session = at(h.sessions, 0);
    session.options.onStart();
    h.advance(TRIAL_RECORD_MS);
    trial.cancel();
    session.resolveFinish('too late');
    await should(trial.result).be.rejectedWith({ code: 'aborted' });
  });

  it('reports an engine that cannot open, before any microphone', async () => {
    const refused = harness(() => {
      throw new BrowserRecognitionError('model-not-installed', 'Install it first.');
    });
    await should(startEngineTrial(refused.ports, refused.onUpdate).result).be.rejectedWith({
      code: 'model-not-installed',
      message: 'Install it first.',
    });
    const broken = harness(() => {
      throw new Error('boom');
    });
    const trial = startEngineTrial(broken.ports, broken.onUpdate);
    await should(trial.result).be.rejectedWith({ code: 'recognition-unavailable' });
    trial.cancel();
  });

  it('formats a duration in seconds, one decimal', () => {
    should(formatSeconds(1_234)).equal('1.2 s');
    should(formatSeconds(0)).equal('0.0 s');
  });
});
