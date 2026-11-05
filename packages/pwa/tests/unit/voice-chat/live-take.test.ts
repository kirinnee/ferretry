/**
 * Proves a Live take over the dictation engines with fake sessions:
 *
 *   - an engine with an early finish keeps recording while its words are worked out, a returning voice
 *     only discards that work, and the words are the early finish cleaned with Fix;
 *   - an engine without one is finished at the end of the turn and a new session carries the words so far;
 *   - live words reach the listener with the carried words in front;
 *   - empty takes, failures (each mapped to its words), a session that cannot be made, aborted answers,
 *     and cancelling at any point.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserRecognitionError } from '../../../src/lib/stt/browser-recognition.ts';
import type { TentativeTake } from '../../../src/lib/stt/tentative-take.ts';
import {
  blockOf,
  type LiveSession,
  type LiveSessionCallbacks,
  liveTakePort,
} from '../../../src/lib/voice-chat/live-take.ts';
import type { LiveBlock, TakeListener } from '../../../src/lib/voice-chat/ports.ts';

class FakeSession {
  started = 0;
  cancelled = 0;
  finishes = 0;
  discarded = 0;
  finishResult: Promise<string> = Promise.resolve('fix the bug');
  early: (() => TentativeTake | null) | null = null;
  startThrows: unknown = null;
  cancelThrows = false;
  constructor(readonly callbacks: LiveSessionCallbacks) {}
  start(): void {
    this.started += 1;
    if (this.startThrows !== null) throw this.startThrows;
  }
  finish(): Promise<string> {
    this.finishes += 1;
    return this.finishResult;
  }
  cancel(): void {
    this.cancelled += 1;
    if (this.cancelThrows) throw new Error('already ended');
  }
  beginFinish(): TentativeTake | null {
    return this.early === null ? null : this.early();
  }
}

/** A session class where beginFinish is not offered at all (Vosk, Browser voice). */
class PlainSession {
  started = 0;
  finishes = 0;
  cancelled = 0;
  finishResult: Promise<string> = Promise.resolve('fix the bug');
  constructor(readonly callbacks: LiveSessionCallbacks) {}
  start(): void {
    this.started += 1;
  }
  finish(): Promise<string> {
    this.finishes += 1;
    return this.finishResult;
  }
  cancel(): void {
    this.cancelled += 1;
  }
}

const rig = (
  options: {
    plain?: boolean;
    block?: LiveBlock;
    clean?: (text: string, signal: AbortSignal) => Promise<{ text: string; kept: 'cleaned' | 'raw' }>;
  } = {},
) => {
  const sessions: (FakeSession | PlainSession)[] = [];
  const cleaned: string[] = [];
  const events: string[] = [];
  const listener: TakeListener = {
    onLive: text => void events.push(`live:${text}`),
    onEnded: () => void events.push('ended'),
    onFailed: block => void events.push(`failed:${block}`),
  };
  const port = liveTakePort({
    createSession: callbacks => {
      if (options.block !== undefined) return options.block;
      const session = options.plain ? new PlainSession(callbacks) : new FakeSession(callbacks);
      sessions.push(session);
      return session as unknown as LiveSession;
    },
    clean:
      options.clean ??
      (async text => {
        cleaned.push(text);
        return { text: `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}.`, kept: 'cleaned' };
      }),
  });
  return { port, sessions, cleaned, events, listener };
};

const earlyTake = (text: Promise<string>): TentativeTake & { discards: number } => {
  const take = {
    text,
    discards: 0,
    discard: () => {
      take.discards += 1;
    },
  };
  return take;
};

describe('a take over an engine with an early finish', () => {
  it('keeps recording while the words are worked out, and cleans them', async () => {
    const { port, sessions, cleaned, listener } = rig();
    const take = port.start(listener);
    const session = sessions[0] as FakeSession;
    should(session.started).equal(1);
    const early = earlyTake(Promise.resolve('fix the bug'));
    session.early = () => early;
    const outcome = await take.endTurn();
    should(outcome).deepEqual({ kind: 'words', text: 'Fix the bug.', raw: 'fix the bug', cleaned: true });
    should(cleaned).deepEqual(['fix the bug']);
    should(session.finishes).equal(0);
    should(session.cancelled).equal(0);
  });

  it('a returning voice discards the early work and carries on recording in the same session', async () => {
    const { port, sessions, listener } = rig();
    const take = port.start(listener);
    const session = sessions[0] as FakeSession;
    const early = earlyTake(new Promise<string>(() => undefined));
    session.early = () => early;
    void take.endTurn();
    should(await take.resume()).be.true();
    should(early.discards).equal(1);
    should(sessions.length).equal(1);
  });

  it('a second end of turn discards the first early finish', async () => {
    const { port, sessions, listener } = rig();
    const take = port.start(listener);
    const session = sessions[0] as FakeSession;
    const first = earlyTake(new Promise<string>(() => undefined));
    const second = earlyTake(Promise.resolve('again'));
    session.early = () => first;
    void take.endTurn();
    session.early = () => second;
    const outcome = await take.endTurn();
    should(first.discards).equal(1);
    should(outcome.kind).equal('words');
  });

  it('an answer that arrives after the voice came back is dropped', async () => {
    const { port, sessions, listener } = rig();
    const take = port.start(listener);
    const session = sessions[0] as FakeSession;
    let answer: (text: string) => void = () => undefined;
    session.early = () => earlyTake(new Promise<string>(resolve => void (answer = resolve)));
    const pending = take.endTurn();
    await take.resume();
    answer('stale');
    should(await pending).deepEqual({ kind: 'empty' });
  });

  it('an early finish that fails reports the engine failure', async () => {
    const { port, sessions, listener } = rig();
    const take = port.start(listener);
    (sessions[0] as FakeSession).early = () =>
      earlyTake(Promise.reject(new BrowserRecognitionError('model-not-installed', 'no model')));
    should(await take.endTurn()).deepEqual({ kind: 'failed', block: 'engine-missing' });
  });
});

describe('a take over an engine that ends at the end of the turn', () => {
  it('finishes the session, and a new one carries the words so far in front of the next', async () => {
    const { port, sessions, cleaned, events, listener } = rig({ plain: true });
    const take = port.start(listener);
    const first = sessions[0] as PlainSession;
    should(await take.endTurn()).deepEqual({ kind: 'words', text: 'Fix the bug.', raw: 'fix the bug', cleaned: true });
    should(first.finishes).equal(1);
    should(await take.resume()).be.true();
    should(sessions.length).equal(2);
    const second = sessions[1] as PlainSession;
    should(second.started).equal(1);
    second.callbacks.onTranscript('and run the tests');
    second.callbacks.onLiveText('and run');
    should(events).deepEqual(['live:fix the bug and run the tests', 'live:fix the bug and run']);
    second.finishResult = Promise.resolve('and run the tests');
    await take.endTurn();
    should(cleaned.at(-1)).equal('fix the bug and run the tests');
  });

  it('keeps the earlier words when the new session heard nothing', async () => {
    const { port, sessions, listener } = rig({ plain: true });
    const take = port.start(listener);
    await take.endTurn();
    await take.resume();
    (sessions[1] as PlainSession).finishResult = Promise.resolve('   ');
    const outcome = await take.endTurn();
    should(outcome.kind).equal('words');
    if (outcome.kind === 'words') should(outcome.raw).equal('fix the bug');
  });

  it('is empty when nothing was ever said', async () => {
    const { port, sessions, listener } = rig({ plain: true });
    const take = port.start(listener);
    (sessions[0] as PlainSession).finishResult = Promise.resolve('  ');
    should(await take.endTurn()).deepEqual({ kind: 'empty' });
    // A resume after an empty turn starts clean.
    should(await take.resume()).be.true();
    should(sessions.length).equal(2);
  });

  it('says a take failed, with the words for it, and treats an abort as nothing', async () => {
    const { port, sessions, listener } = rig({ plain: true });
    const take = port.start(listener);
    const session = sessions[0] as PlainSession;
    session.finishResult = Promise.reject(new BrowserRecognitionError('permission-denied', 'denied'));
    should(await take.endTurn()).deepEqual({ kind: 'failed', block: 'mic-blocked' });
    session.finishResult = Promise.reject(new BrowserRecognitionError('aborted', 'cancelled'));
    should(await take.endTurn()).deepEqual({ kind: 'empty' });
    session.finishResult = Promise.reject(new Error('odd'));
    should((await take.endTurn()).kind).equal('failed');
  });

  it('cannot resume when the new session cannot be made', async () => {
    let made = 0;
    const events: string[] = [];
    const port = liveTakePort({
      createSession: callbacks => {
        made += 1;
        return made === 1 ? (new PlainSession(callbacks) as unknown as LiveSession) : 'engine-failed';
      },
      clean: async text => ({ text, kept: 'raw' }),
    });
    const take = port.start({
      onLive: () => undefined,
      onEnded: () => undefined,
      onFailed: block => void events.push(block),
    });
    await take.endTurn();
    should(await take.resume()).be.false();
    should(events).deepEqual(['engine-failed']);
  });
});

describe('cleaning', () => {
  it('reports raw words when clean-up changed nothing', async () => {
    const { port, listener } = rig({ plain: true, clean: async text => ({ text, kept: 'raw' }) });
    const outcome = await port.start(listener).endTurn();
    should(outcome).deepEqual({ kind: 'words', text: 'fix the bug', raw: 'fix the bug', cleaned: false });
  });

  it('drops the cleaned words if the voice came back while cleaning', async () => {
    let done: (value: { text: string; kept: 'cleaned' }) => void = () => undefined;
    const { port, listener } = rig({ plain: true, clean: () => new Promise(resolve => void (done = resolve)) });
    const take = port.start(listener);
    const pending = take.endTurn();
    await Promise.resolve();
    await Promise.resolve();
    await take.resume();
    done({ text: 'late', kept: 'cleaned' });
    should(await pending).deepEqual({ kind: 'empty' });
  });
});

describe('session callbacks', () => {
  it('maps failures to words, ignores an abort, and ends the take on a limit or an abort of the browser', () => {
    const { port, sessions, events, listener } = rig();
    port.start(listener);
    const callbacks = (sessions[0] as FakeSession).callbacks;
    callbacks.onStart();
    callbacks.onMonitor?.(null);
    callbacks.onFailure(new BrowserRecognitionError('no-microphone', 'none'));
    callbacks.onFailure(new BrowserRecognitionError('recognition-network', 'offline'));
    callbacks.onFailure(new BrowserRecognitionError('aborted', 'cancelled'));
    callbacks.onLimit();
    callbacks.onAbort();
    should(events).deepEqual(['failed:mic-blocked', 'failed:engine-failed', 'ended', 'ended']);
  });

  it('drops everything a replaced or cancelled session says', async () => {
    const { port, sessions, events, listener } = rig({ plain: true });
    const take = port.start(listener);
    const first = (sessions[0] as PlainSession).callbacks;
    await take.endTurn();
    await take.resume();
    first.onTranscript('stale');
    first.onFailure(new BrowserRecognitionError('permission-denied', 'x'));
    first.onLimit();
    first.onAbort();
    first.onLiveText('stale');
    take.cancel();
    const second = (sessions[1] as PlainSession).callbacks;
    second.onTranscript('late');
    should(events).deepEqual([]);
  });
});

describe('failing to start, and cancelling', () => {
  it('reports the block when no session can be made', () => {
    const { port, events, listener } = rig({ block: 'engine-not-chosen' });
    const take = port.start(listener);
    should(events).deepEqual(['failed:engine-not-chosen']);
    take.cancel();
  });

  it('reports a session whose start throws', async () => {
    const events: string[] = [];
    const port = liveTakePort({
      createSession: callbacks => {
        const session = new FakeSession(callbacks);
        session.startThrows = new BrowserRecognitionError('permission-denied', 'denied');
        return session as unknown as LiveSession;
      },
      clean: async text => ({ text, kept: 'raw' }),
    });
    const take = port.start({
      onLive: () => undefined,
      onEnded: () => undefined,
      onFailed: block => void events.push(block),
    });
    should(events).deepEqual(['mic-blocked']);
    should(await take.endTurn()).deepEqual({ kind: 'empty' });
  });

  it('cancels the session and discards the early work, once, and answers nothing afterwards', async () => {
    const { port, sessions, listener } = rig();
    const take = port.start(listener);
    const session = sessions[0] as FakeSession;
    session.cancelThrows = true;
    const early = earlyTake(new Promise<string>(() => undefined));
    session.early = () => early;
    void take.endTurn();
    take.cancel();
    take.cancel();
    should(session.cancelled).equal(1);
    should(early.discards).equal(1);
    should(await take.endTurn()).deepEqual({ kind: 'empty' });
    should(await take.resume()).be.false();
  });

  it('answers an in-flight finish with nothing once cancelled', async () => {
    const { port, sessions, listener } = rig({ plain: true });
    const take = port.start(listener);
    let finish: (text: string) => void = () => undefined;
    (sessions[0] as PlainSession).finishResult = new Promise(resolve => void (finish = resolve));
    const pending = take.endTurn();
    take.cancel();
    finish('late');
    should(await pending).deepEqual({ kind: 'empty' });
  });
});

describe('blockOf', () => {
  it('names the words for each failure', () => {
    const code = (value: ConstructorParameters<typeof BrowserRecognitionError>[0]): LiveBlock =>
      blockOf(new BrowserRecognitionError(value, 'x'));
    should(code('permission-denied')).equal('mic-blocked');
    should(code('no-microphone')).equal('mic-blocked');
    should(code('model-not-installed')).equal('engine-missing');
    for (const other of [
      'recognition-network',
      'recognition-unavailable',
      'bad-audio',
      'recognition-failed',
      'aborted',
    ] as const)
      should(code(other)).equal('engine-failed');
  });
});
