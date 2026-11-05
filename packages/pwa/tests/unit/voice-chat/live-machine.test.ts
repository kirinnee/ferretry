/**
 * Proves the Live loop's reducer as tables of events and the effects they cause:
 *
 *   - the happy path: start → listening → hearing → ring → words → settle → send → working → listening;
 *   - every refusal to start (no send rights, another tab, the mic or engine) and every way out;
 *   - the races: voice back during the ring (the early finish is void and a late answer is ignored),
 *     a short burst after that, typing / hold / a hidden tab while words are still being worked out;
 *   - a send that fails keeps the words On hold; an empty or failed take goes back to listening;
 *   - the settle rule (words visible 500 ms before an automatic send), "Send now", and a zero grace;
 *   - Reading with a speaker, the needs-input hold, the idle end, the ferret stopping;
 *   - totality: every event in every phase returns a well-formed step and never throws.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_GRACE_MS,
  GRACE_RANGE_MS,
  IDLE_END_MS,
  INITIAL_LIVE_STATE,
  type LiveEffect,
  type LiveEvent,
  type LivePhase,
  type LiveState,
  liveReduce,
  micIsOpen,
  resolveGraceMs,
  SETTLE_MS,
} from '../../../src/lib/voice-chat/live-machine.ts';

interface Run {
  readonly state: LiveState;
  readonly effects: readonly LiveEffect[];
  readonly all: readonly LiveEffect[];
}

/** Fold events over a state; `effects` are those of the LAST event, `all` of every event. */
const run = (events: readonly LiveEvent[], from: LiveState = INITIAL_LIVE_STATE): Run => {
  let state = from;
  let effects: readonly LiveEffect[] = [];
  const all: LiveEffect[] = [];
  for (const event of events) {
    const next = liveReduce(state, event);
    state = next.state;
    effects = next.effects;
    all.push(...next.effects);
  }
  return { state, effects, all };
};

const types = (effects: readonly LiveEffect[]): string[] => effects.map(effect => effect.type);

const START: LiveEvent = { type: 'start', atMs: 0, canSend: true, visible: true };
const LISTENING: readonly LiveEvent[] = [START, { type: 'locks', granted: true }, { type: 'listening' }];
const HEARING: readonly LiveEvent[] = [
  ...LISTENING,
  { type: 'speech-start' },
  { type: 'live-words', text: 'fix the bug' },
];
const turnEnd = (atMs = 5_000): LiveEvent => ({
  type: 'turn-end',
  atMs,
  speechEndedAtMs: atMs - 1_500,
  reason: 'pause',
});
const SENDING: readonly LiveEvent[] = [...HEARING, turnEnd()];
/** Words ready 300 ms in; the ring has not finished. */
const WORDS: readonly LiveEvent[] = [...SENDING, { type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Fix the bug.' }];
const SENT: readonly LiveEvent[] = [...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'sent', atMs: 6_600 }];
const WORKING = run(SENT).state;

describe('liveReduce — the happy path', () => {
  it('walks one whole turn and says what to do at each step', () => {
    const started = run([START]);
    should(started.state.phase).equal('starting');
    should(types(started.effects)).deepEqual(['acquireLocks', 'openMic']);

    should(run([START, { type: 'locks', granted: true }]).state.phase).equal('starting');
    const listening = run(LISTENING);
    should(listening.state.phase).equal('listening');
    should(listening.effects).deepEqual([{ type: 'startTimer', kind: 'idle', ms: IDLE_END_MS }]);
    should(micIsOpen(listening.state)).be.true();

    const hearing = run([...LISTENING, { type: 'speech-start' }]);
    should(hearing.state.phase).equal('hearing');
    should(types(hearing.effects)).deepEqual(['cancelTimers']);

    const sending = run(SENDING);
    should(sending.state.phase).equal('sending');
    should(sending.state.countdown).deepEqual({ startedAtMs: 5_000, durationMs: DEFAULT_GRACE_MS });
    should(sending.effects).deepEqual([
      { type: 'cancelTimers' },
      { type: 'showWords', text: 'fix the bug' },
      { type: 'beginTurnWords', attempt: 1 },
      { type: 'startCountdown', ms: DEFAULT_GRACE_MS },
    ]);

    const words = run(WORDS);
    should(words.effects).deepEqual([{ type: 'showWords', text: 'Fix the bug.' }]);
    should(words.state.wordsReady).be.true();
    should(micIsOpen(words.state)).be.true();

    // Ring done at 6.5 s, words on screen since 5.3 s: visible long enough, so it goes.
    const sendEffects = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }]);
    should(types(sendEffects.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'closeMic', 'send']);
    should(sendEffects.state.sendInFlight).be.true();
    should(micIsOpen(sendEffects.state)).be.false();

    const sent = run(SENT);
    should(sent.state.phase).equal('working');
    should(sent.state.turn).equal(1);
    should(sent.state.sentAtMs).equal(6_600);
    should(sent.effects).deepEqual([
      {
        type: 'recordTurn',
        numbers: {
          turn: 1,
          endReason: 'pause',
          endToWordsMs: 300,
          graceMs: DEFAULT_GRACE_MS,
          endToSendMs: 1_600,
          lastWordToSentMs: 3_100,
          resumed: false,
          sendNow: false,
        },
      },
      { type: 'watchReply' },
    ]);

    const again = run([{ type: 'reply', signal: 'done' }], sent.state);
    should(again.state.phase).equal('starting');
    should(types(again.effects)).deepEqual(['stopWatchReply', 'openMic']);
    should(run([...SENT, { type: 'reply', signal: 'done' }, { type: 'listening' }]).state.phase).equal('listening');
  });

  it('ignores a "working" signal and anything else while the ferret works', () => {
    should(run([{ type: 'reply', signal: 'working' }], WORKING).state).equal(WORKING);
    should(run([{ type: 'typing' }], WORKING).state).equal(WORKING);
    should(run([{ type: 'hold' }], WORKING).state).equal(WORKING);
  });
});

describe('liveReduce — starting, and refusing to', () => {
  const blocked = (block: string) => ({ kind: 'blocked', block });

  it('refuses a device without send rights, and says so', () => {
    const result = run([{ ...START, canSend: false } as LiveEvent]);
    should(result.state.phase).equal('off');
    should(result.state.notice).deepEqual(blocked('no-send-rights'));
    should(result.effects).deepEqual([]);
  });

  it('refuses when another tab is Live, and closes what it opened', () => {
    const result = run([START, { type: 'locks', granted: false }]);
    should(result.state.phase).equal('off');
    should(result.state.notice).deepEqual(blocked('other-tab'));
    should(types(result.effects)).deepEqual([
      'cancelCountdown',
      'cancelTimers',
      'closeMic',
      'stopWatchReply',
      'stopSpeaking',
      'releaseLocks',
    ]);
  });

  it('turns a blocked mic or engine into words on the bar', () => {
    for (const block of ['mic-blocked', 'engine-not-chosen', 'engine-missing', 'ios-browser-voice'] as const) {
      const result = run([START, { type: 'blocked', block }]);
      should(result.state.phase).equal('off');
      should(result.state.notice).deepEqual(blocked(block));
    }
  });

  it('keeps the graceMs a setting asks for (clamped) and whether a speaker exists', () => {
    const custom = run([{ ...START, graceMs: 2_500, canRead: true } as LiveEvent]).state;
    should(custom.graceMs).equal(2_500);
    should(custom.canRead).be.true();
    should(run([{ ...START, graceMs: 99_999 } as LiveEvent]).state.graceMs).equal(GRACE_RANGE_MS.max);
    should(run([{ ...START, graceMs: -3 } as LiveEvent]).state.graceMs).equal(GRACE_RANGE_MS.min);
    should(run([{ ...START, graceMs: 'soon' } as LiveEvent]).state.graceMs).equal(DEFAULT_GRACE_MS);
    should(resolveGraceMs(1_234.6)).equal(1_235);
    should(resolveGraceMs(Number.NaN)).equal(DEFAULT_GRACE_MS);
  });

  it('starts paused when the page is hidden as the take opens', () => {
    const result = run([
      { ...START, visible: false } as LiveEvent,
      { type: 'locks', granted: true },
      { type: 'listening' },
    ]);
    should(result.state.phase).equal('paused');
    should(result.state.pauseReason).equal('hidden');
    should(types(result.effects)).deepEqual(['cancelTimers', 'closeMic']);
  });

  it('pauses when the page hides while it is still opening', () => {
    const result = run([START, { type: 'visibility', visible: false }]);
    should(result.state.phase).equal('paused');
    should(result.state.hidden).be.true();
  });

  it('ignores events that do not belong to a start in progress', () => {
    const starting = run([START]).state;
    should(run([{ type: 'speech-start' }], starting).state).equal(starting);
  });

  it('does nothing in the off phase but start, end and visibility', () => {
    for (const event of [
      { type: 'speech-start' },
      { type: 'hold' },
      { type: 'end' },
      { type: 'reply', signal: 'ended' },
    ] as LiveEvent[]) {
      const result = liveReduce(INITIAL_LIVE_STATE, event);
      should(result.state).equal(INITIAL_LIVE_STATE);
      should(result.effects).deepEqual([]);
    }
    should(run([{ type: 'visibility', visible: false }]).state.hidden).be.true();
  });
});

describe('liveReduce — listening and hearing', () => {
  it('goes back to listening when a burst was too short to be speech, taking the preview away', () => {
    const result = run([...HEARING, { type: 'speech-cancel', atMs: 3_000 }]);
    should(result.state.phase).equal('listening');
    should(result.state.words).equal('');
    should(types(result.effects)).deepEqual(['clearWords', 'startTimer']);
  });

  it('ignores a cancel with nothing heard, a repeated start, and a turn that has not started', () => {
    const listening = run(LISTENING).state;
    should(run([{ type: 'speech-cancel', atMs: 1 }], listening).state).equal(listening);
    should(run([turnEnd()], listening).state).equal(listening);
    should(run([{ type: 'send-now', atMs: 9 }], listening).state).equal(listening);
    const hearing = run(HEARING).state;
    should(run([{ type: 'speech-start' }], hearing).state).equal(hearing);
    should(run([{ type: 'sent', atMs: 1 }], hearing).state).equal(hearing);
  });

  it('ends an unusually long take like any other (max turn)', () => {
    const result = run([...HEARING, { type: 'turn-end', atMs: 130_000, speechEndedAtMs: 129_000, reason: 'max-turn' }]);
    should(result.state.phase).equal('sending');
    should(result.state.endReason).equal('max-turn');
  });

  it('skips the preview when nothing was heard in words (a whole-take engine)', () => {
    const result = run([...LISTENING, { type: 'speech-start' }, turnEnd()]);
    should(types(result.effects)).deepEqual(['cancelTimers', 'beginTurnWords', 'startCountdown']);
    should(result.state.shown).be.false();
  });

  it('"Send now" while hearing ends the turn at once and sends as soon as the words are ready', () => {
    const result = run([...HEARING, { type: 'send-now', atMs: 4_000 }]);
    should(result.state.phase).equal('sending');
    should(result.state.sendWhenReady).be.true();
    const words = run([{ type: 'turn-words', attempt: 1, atMs: 4_400, text: 'Fix the bug.' }], result.state);
    should(types(words.effects)).deepEqual(['showWords', 'cancelCountdown', 'cancelTimers', 'closeMic', 'send']);
    const sent = run([{ type: 'sent', atMs: 4_500 }], words.state);
    should(sent.effects[0]).containEql({ type: 'recordTurn' });
    should((sent.effects[0] as { numbers: { sendNow: boolean } }).numbers.sendNow).be.true();
  });

  it('ends Live when ten minutes pass with no speech, but never mid-sentence', () => {
    const idle = run([...LISTENING, { type: 'timer', kind: 'idle', atMs: IDLE_END_MS }]);
    should(idle.state.phase).equal('off');
    should(idle.state.notice).deepEqual({ kind: 'ended', why: 'idle' });
    should(run([...HEARING, { type: 'timer', kind: 'idle', atMs: 1 }]).state.phase).equal('hearing');
    should(run([...LISTENING, { type: 'timer', kind: 'settle', atMs: 1 }]).state.phase).equal('listening');
  });

  it('turns a take that fails while listening into a refusal', () => {
    const result = run([...HEARING, { type: 'blocked', block: 'engine-failed' }]);
    should(result.state.phase).equal('off');
    should(result.state.notice).deepEqual({ kind: 'blocked', block: 'engine-failed' });
  });

  it('puts the words in the composer as they are heard', () => {
    should(run([...HEARING, { type: 'live-words', text: 'fix the bug now' }]).state.words).equal('fix the bug now');
  });
});

describe('liveReduce — the ring and the settle rule', () => {
  it('waits for words that are not ready when the ring ends, then waits the settle time', () => {
    const ringDone = run([...SENDING, { type: 'countdown-done', atMs: 6_500 }]);
    should(ringDone.state.countdownElapsed).be.true();
    should(ringDone.effects).deepEqual([]);
    const words = run([{ type: 'turn-words', attempt: 1, atMs: 7_000, text: 'Fix the bug.' }], ringDone.state);
    should(words.effects).deepEqual([
      { type: 'showWords', text: 'Fix the bug.' },
      { type: 'startTimer', kind: 'settle', ms: SETTLE_MS },
    ]);
    should(types(run([{ type: 'timer', kind: 'settle', atMs: 7_500 }], words.state).effects)).deepEqual([
      'cancelCountdown',
      'cancelTimers',
      'closeMic',
      'send',
    ]);
  });

  it('holds the send until the words have been visible for the settle time', () => {
    const late = run([...WORDS, { type: 'countdown-done', atMs: 5_400 }]);
    should(late.effects).deepEqual([{ type: 'startTimer', kind: 'settle', ms: 400 }]);
    should(types(run([{ type: 'timer', kind: 'settle', atMs: 5_800 }], late.state).effects)).deepEqual([
      'cancelCountdown',
      'cancelTimers',
      'closeMic',
      'send',
    ]);
  });

  it('ignores a settle timer before words exist, a stray ring end, and another kind of timer', () => {
    const sending = run(SENDING).state;
    should(run([{ type: 'timer', kind: 'settle', atMs: 1 }], sending).state).equal(sending);
    should(run([{ type: 'timer', kind: 'idle', atMs: 1 }], sending).state).equal(sending);
    const idle = run(LISTENING).state;
    should(run([{ type: 'countdown-done', atMs: 1 }], idle).state).equal(idle);
    const ringless = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }]).state;
    should(run([{ type: 'countdown-done', atMs: 6_600 }], ringless).state).equal(ringless);
  });

  it('with a zero grace sends the moment the words are shown', () => {
    const zero = run([
      { ...START, graceMs: 0 } as LiveEvent,
      { type: 'locks', granted: true },
      { type: 'listening' },
      { type: 'speech-start' },
      turnEnd(),
    ]);
    should(types(zero.effects)).deepEqual(['cancelTimers', 'beginTurnWords']);
    should(zero.state.countdown).equal(null);
    const words = run([{ type: 'turn-words', attempt: 1, atMs: 5_200, text: 'Hi.' }], zero.state);
    should(types(words.effects)).deepEqual(['showWords', 'cancelCountdown', 'cancelTimers', 'closeMic', 'send']);
  });

  it('"Send now" before the words are ready sends on arrival; after, at once', () => {
    const early = run([...SENDING, { type: 'send-now', atMs: 5_100 }]);
    should(early.state.sendWhenReady).be.true();
    should(types(run([{ type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Hi.' }], early.state).effects)).deepEqual([
      'showWords',
      'cancelCountdown',
      'cancelTimers',
      'closeMic',
      'send',
    ]);
    should(types(run([...WORDS, { type: 'send-now', atMs: 5_400 }]).effects)).deepEqual([
      'cancelCountdown',
      'cancelTimers',
      'closeMic',
      'send',
    ]);
  });

  it('ignores Hold, typing, visibility and a second send while the message is on the wire', () => {
    const flying = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }]).state;
    for (const event of [
      { type: 'hold' },
      { type: 'typing' },
      { type: 'visibility', visible: false },
      { type: 'send-now', atMs: 6_600 },
      { type: 'turn-words', attempt: 1, atMs: 6_600, text: 'x' },
    ] as LiveEvent[]) {
      const result = liveReduce(flying, event);
      should(result.effects).deepEqual([]);
      should(result.state.phase).equal('sending');
    }
  });
});

describe('liveReduce — races', () => {
  it('voice returning during the ring cancels it and voids the early finish', () => {
    const back = run([...SENDING, { type: 'speech-start' }]);
    should(back.state.phase).equal('hearing');
    should(back.state.attempt).equal(2);
    should(back.state.resumed).be.true();
    should(back.state.countdown).equal(null);
    should(types(back.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'resumeListening']);
    // The cancelled attempt's answer arrives late: ignored.
    const late = run([{ type: 'turn-words', attempt: 1, atMs: 5_400, text: 'stale' }], back.state);
    should(late.state).equal(back.state);
    should(late.effects).deepEqual([]);
    for (const event of [
      { type: 'turn-empty', attempt: 1 },
      { type: 'turn-failed', attempt: 1, block: 'engine-failed' },
    ] as LiveEvent[])
      should(run([event], back.state).state).equal(back.state);
  });

  it("voice returning after the words were ready also cancels the ring and the words' readiness", () => {
    const back = run([...WORDS, { type: 'speech-start' }]);
    should(back.state.wordsReady).be.false();
    should(back.state.sendWhenReady).be.false();
  });

  it('ignores a stale answer in the sending phase', () => {
    const sending = run(SENDING).state;
    for (const event of [
      { type: 'turn-words', attempt: 7, atMs: 5_400, text: 'x' },
      { type: 'turn-empty', attempt: 7 },
      { type: 'turn-failed', attempt: 7, block: 'engine-failed' },
    ] as LiveEvent[])
      should(run([event], sending).state).equal(sending);
  });

  it('a short burst after the voice came back ends the turn again, from the earlier speech', () => {
    const result = run([...SENDING, { type: 'speech-start' }, { type: 'speech-cancel', atMs: 6_000 }]);
    should(result.state.phase).equal('sending');
    should(result.state.attempt).equal(3);
    should(result.state.countdown).deepEqual({ startedAtMs: 6_000, durationMs: DEFAULT_GRACE_MS });
    should(result.state.speechEndedAtMs).equal(3_500);
    should(types(result.effects)).deepEqual(['cancelTimers', 'showWords', 'beginTurnWords', 'startCountdown']);
  });

  it('a normal turn end after the voice came back starts a fresh ring', () => {
    const result = run([...SENDING, { type: 'speech-start' }, turnEnd(9_000)]);
    should(result.state.attempt).equal(3);
    should(result.state.resumed).be.true();
    should(
      run([{ type: 'turn-words', attempt: 3, atMs: 9_300, text: 'Fix the bug and test it.' }], result.state).state
        .words,
    ).equal('Fix the bug and test it.');
    const sent = run(
      [
        { type: 'turn-words', attempt: 3, atMs: 9_300, text: 'x' },
        { type: 'countdown-done', atMs: 10_500 },
        { type: 'sent', atMs: 10_600 },
      ],
      result.state,
    );
    should((sent.effects[0] as { numbers: { resumed: boolean } }).numbers.resumed).be.true();
  });

  it('typing while the words are being worked out waits for them, then holds with them on screen', () => {
    const typing = run([...SENDING, { type: 'typing' }]);
    should(typing.state.phase).equal('sending');
    should(typing.state.park).deepEqual({ phase: 'hold', reason: 'typing' });
    should(typing.state.countdown).equal(null);
    should(types(typing.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'stopCapture']);
    should(micIsOpen(typing.state)).be.false();
    const words = run([{ type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Fix the bug.' }], typing.state);
    should(words.state.phase).equal('hold');
    should(words.state.holdReason).equal('typing');
    should(words.state.words).equal('Fix the bug.');
    should(words.state.shown).be.true();
    should(types(words.effects)).deepEqual(['showWords', 'closeMic']);
    // Nothing fires while parked: no ring, no settle, no Send now.
    should(run([{ type: 'countdown-done', atMs: 6_500 }], typing.state).effects).deepEqual([]);
    should(run([{ type: 'timer', kind: 'settle', atMs: 6_500 }], typing.state).effects).deepEqual([]);
    should(run([{ type: 'send-now', atMs: 6_500 }], typing.state).state).equal(typing.state);
    should(
      run([{ type: 'countdown-done', atMs: 6_500 }], {
        ...typing.state,
        countdown: typing.state.countdown ?? { startedAtMs: 0, durationMs: 1 },
      }).effects,
    ).deepEqual([]);
  });

  it('typing once the words are ready holds at once', () => {
    const result = run([...WORDS, { type: 'typing' }]);
    should(result.state.phase).equal('hold');
    should(result.state.holdReason).equal('typing');
    should(result.state.words).equal('Fix the bug.');
    should(types(result.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'closeMic']);
    should(micIsOpen(result.state)).be.false();
  });

  it('Hold while listening or hearing closes the microphone and keeps the words', () => {
    const hearing = run([...HEARING, { type: 'hold' }]);
    should(hearing.state.phase).equal('hold');
    should(hearing.state.holdReason).equal('user');
    should(hearing.state.words).equal('fix the bug');
    const listening = run([...LISTENING, { type: 'typing' }]);
    should(listening.state.holdReason).equal('typing');
  });

  it('a hidden tab pauses a listening or counting down Live; words stay', () => {
    for (const events of [LISTENING, HEARING, WORDS]) {
      const result = run([...events, { type: 'visibility', visible: false }]);
      should(result.state.phase).equal('paused');
      should(result.state.pauseReason).equal('hidden');
      should(result.state.hidden).be.true();
      should(types(result.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'closeMic']);
    }
    const parked = run([...SENDING, { type: 'visibility', visible: false }]);
    should(parked.state.park).deepEqual({ phase: 'paused', reason: 'hidden' });
    const arrived = run([{ type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Fix the bug.' }], parked.state);
    should(arrived.state.phase).equal('paused');
    should(arrived.state.words).equal('Fix the bug.');
  });

  it('visibility changes while holding, working or off only update the flag; coming back needs a tap', () => {
    const held = run([...HEARING, { type: 'hold' }, { type: 'visibility', visible: false }]);
    should(held.state.phase).equal('hold');
    should(run([{ type: 'visibility', visible: true }], held.state).state.hidden).be.false();
    const paused = run([...LISTENING, { type: 'visibility', visible: false }, { type: 'visibility', visible: true }]);
    should(paused.state.phase).equal('paused');
    should(paused.state.hidden).be.false();
    should(run([{ type: 'visibility', visible: false }], WORKING).state.phase).equal('working');
  });
});

describe('liveReduce — a take that comes to nothing', () => {
  it('goes quietly back to listening on an empty take, and takes the preview away', () => {
    const result = run([...SENDING, { type: 'turn-empty', attempt: 1 }]);
    should(result.state.phase).equal('listening');
    should(result.state.words).equal('');
    should(result.state.notice).equal(null);
    should(types(result.effects)).deepEqual([
      'cancelCountdown',
      'cancelTimers',
      'clearWords',
      'resumeListening',
      'startTimer',
    ]);
  });

  it('goes back to listening with a notice when the engine failed, keeping nothing on screen', () => {
    const result = run([...SENDING, { type: 'turn-failed', attempt: 1, block: 'engine-failed' }]);
    should(result.state.phase).equal('listening');
    should(result.state.notice).deepEqual({ kind: 'take-failed', block: 'engine-failed' });
    should(types(result.effects)).deepEqual([
      'cancelCountdown',
      'cancelTimers',
      'clearWords',
      'resumeListening',
      'startTimer',
    ]);
    // The next speech clears the notice.
    should(run([{ type: 'speech-start' }], result.state).state.notice).equal(null);
  });

  it('a take that cannot continue during the ring ends Live', () => {
    const result = run([...SENDING, { type: 'blocked', block: 'mic-blocked' }]);
    should(result.state.phase).equal('off');
    should(result.state.notice).deepEqual({ kind: 'blocked', block: 'mic-blocked' });
  });
});

describe('liveReduce — a send that fails', () => {
  const failed = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'send-failed' }]);

  it('stays On hold with the words kept and nothing retried', () => {
    should(failed.state.phase).equal('hold');
    should(failed.state.holdReason).equal('send-failed');
    should(failed.state.words).equal('Fix the bug.');
    should(failed.state.shown).be.true();
    should(failed.effects).deepEqual([]);
  });

  it('retries only when the person presses Send now', () => {
    const retry = run([{ type: 'send-now', atMs: 8_000 }], failed.state);
    should(retry.state.phase).equal('sending');
    should(retry.state.sendInFlight).be.true();
    should(types(retry.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'closeMic', 'send']);
    const sent = run([{ type: 'sent', atMs: 8_100 }], retry.state);
    should(sent.state.phase).equal('working');
    should((sent.effects[0] as { numbers: { sendNow: boolean } }).numbers.sendNow).be.true();
    should(run([{ type: 'send-failed' }], retry.state).state.holdReason).equal('send-failed');
  });

  it('Resume goes back to listening and the words stay in the composer (they are not cleared)', () => {
    const resumed = run([{ type: 'resume' }], failed.state);
    should(resumed.state.phase).equal('starting');
    should(types(resumed.effects)).deepEqual(['openMic']);
    should(resumed.effects).not.containEql({ type: 'clearWords' });
  });

  it('ignores events a hold does not answer', () => {
    should(run([{ type: 'speech-start' }], failed.state).state).equal(failed.state);
  });
});

describe('liveReduce — hold and pause, then resume', () => {
  it('Resume from a hold reopens the microphone', () => {
    const held = run([...LISTENING, { type: 'hold' }]).state;
    const result = run([{ type: 'resume' }, { type: 'listening' }], held);
    should(result.state.phase).equal('listening');
  });

  it('Resume Live from a pause needs the page visible, then re-acquires the locks', () => {
    const paused = run([...LISTENING, { type: 'visibility', visible: false }]).state;
    should(run([{ type: 'resume' }], paused).state).equal(paused);
    const back = run([{ type: 'visibility', visible: true }, { type: 'resume' }], paused);
    should(back.state.phase).equal('starting');
    should(types(back.effects)).deepEqual(['acquireLocks', 'openMic']);
    should(run([{ type: 'speech-start' }], paused).state).equal(paused);
  });

  it('End leaves with nothing open, and no notice', () => {
    for (const events of [LISTENING, HEARING, SENDING, WORDS, [...LISTENING, { type: 'hold' }] as LiveEvent[]]) {
      const result = run([...events, { type: 'end' }]);
      should(result.state.phase).equal('off');
      should(result.state.notice).equal(null);
      should(types(result.effects)).deepEqual([
        'cancelCountdown',
        'cancelTimers',
        'closeMic',
        'stopWatchReply',
        'stopSpeaking',
        'releaseLocks',
      ]);
    }
    should(run([{ type: 'end' }], WORKING).state.phase).equal('off');
  });
});

describe('liveReduce — after the send', () => {
  it('a question from the ferret holds Live and shows the prompt', () => {
    const result = run([{ type: 'reply', signal: 'needs-input' }], WORKING);
    should(result.state.phase).equal('hold');
    should(result.state.holdReason).equal('needs-input');
    should(types(result.effects)).deepEqual(['stopWatchReply']);
    // Send now is not offered for a question; Resume listens again.
    should(run([{ type: 'send-now', atMs: 1 }], result.state).state).equal(result.state);
    should(run([{ type: 'resume' }], result.state).state.phase).equal('starting');
  });

  it('the ferret stopping ends Live with a notice', () => {
    for (const events of [LISTENING, WORDS]) {
      const result = run([...events, { type: 'reply', signal: 'ended' }]);
      should(result.state.phase).equal('off');
      should(result.state.notice).deepEqual({ kind: 'ended', why: 'ferret-stopped' });
    }
    should(run([{ type: 'reply', signal: 'ended' }], WORKING).state.notice).deepEqual({
      kind: 'ended',
      why: 'ferret-stopped',
    });
  });

  it('a reply that lands while the tab is hidden pauses instead of listening', () => {
    const away = run(
      [
        { type: 'visibility', visible: false },
        { type: 'reply', signal: 'done' },
      ],
      WORKING,
    );
    should(away.state.phase).equal('paused');
    should(away.state.pauseReason).equal('hidden');
    should(types(away.effects)).deepEqual(['stopWatchReply']);
  });

  it('with a speaker, a finished reply is read, and a tap or the end of the reading goes back to listening', () => {
    const base = { ...WORKING, canRead: true };
    const reading = run([{ type: 'reply', signal: 'done' }], base);
    should(reading.state.phase).equal('reading');
    should(types(reading.effects)).deepEqual(['stopWatchReply', 'speak']);
    for (const event of [{ type: 'speak-done' }, { type: 'skip' }] as LiveEvent[]) {
      const done = run([event], reading.state);
      should(done.state.phase).equal('starting');
      should(types(done.effects)).deepEqual(['stopSpeaking', 'openMic']);
    }
    should(run([{ type: 'typing' }], reading.state).state).equal(reading.state);
  });

  it('a hidden tab stops the reading and pauses', () => {
    const reading = run([{ type: 'reply', signal: 'done' }], { ...WORKING, canRead: true }).state;
    const away = run([{ type: 'visibility', visible: false }], reading);
    should(away.state.phase).equal('paused');
    should(types(away.effects)).deepEqual(['stopSpeaking']);
  });

  it('keeps counting turns across a Live session and across a restart', () => {
    const second = run([...LISTENING.slice(0, 0), { type: 'end' }], WORKING).state;
    should(second.turn).equal(1);
    should(run([START], second).state.turn).equal(1);
  });
});

/** The three ways to stop the loop, each as the event that does it. */
const STOPS = [
  { name: 'Hold', event: { type: 'hold' } as LiveEvent, park: { phase: 'hold', reason: 'user' } },
  { name: 'typing', event: { type: 'typing' } as LiveEvent, park: { phase: 'hold', reason: 'typing' } },
  {
    name: 'a hidden tab',
    event: { type: 'visibility', visible: false } as LiveEvent,
    park: { phase: 'paused', reason: 'hidden' },
  },
] as const;

const landed = (state: LiveState, stop: (typeof STOPS)[number]): void => {
  should(state.phase).equal(stop.park.phase);
  should(state.park).equal(null);
  should(state.countdown).equal(null);
  should(state.sendInFlight).be.false();
  should(micIsOpen(state)).be.false();
  should(state.holdReason ?? state.pauseReason).equal(stop.park.reason);
};

describe('liveReduce — a stop is sticky (the surprise-send rule)', () => {
  for (const stop of STOPS) {
    describe(stop.name, () => {
      const parked = run([...SENDING, stop.event]);

      it('stops capture at once and waits for the words, with nothing able to send', () => {
        should(parked.state.phase).equal('sending');
        should(parked.state.park).deepEqual(stop.park);
        should(types(parked.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'stopCapture']);
        should(micIsOpen(parked.state)).be.false();
        // Asking again changes nothing: the first stop stands.
        const again = run(
          STOPS.map(other => other.event),
          parked.state,
        );
        should(again.state.park).deepEqual(stop.park);
        should(types(again.all)).not.containEql('stopCapture');
      });

      it('is NOT undone by renewed speech: no hearing, no new attempt, no countdown, no send', () => {
        const speech = run(
          [
            { type: 'speech-start' },
            { type: 'speech-cancel', atMs: 6_000 },
            { type: 'live-words', text: 'and more' },
            turnEnd(8_000),
            { type: 'countdown-done', atMs: 9_500 },
            { type: 'timer', kind: 'settle', atMs: 10_000 },
            { type: 'send-now', atMs: 10_000 },
            { type: 'resume' },
          ],
          parked.state,
        );
        should(speech.state).deepEqual(parked.state);
        should(speech.all).deepEqual([]);
      });

      it('lands where it was asked when the words arrive, even after renewed speech, and a second pause cannot send', () => {
        const events: LiveEvent[] = [
          { type: 'speech-start' },
          turnEnd(8_000),
          { type: 'countdown-done', atMs: 9_500 },
          { type: 'turn-words', attempt: 1, atMs: 9_600, text: 'Fix the bug.' },
        ];
        const result = run(events, parked.state);
        landed(result.state, stop);
        should(result.state.words).equal('Fix the bug.');
        should(result.state.shown).be.true();
        should(types(result.all)).not.containEql('send');
        should(types(result.all)).deepEqual(['showWords', 'closeMic']);
        // And later events cannot revive it.
        const later = run([{ type: 'timer', kind: 'settle', atMs: 20_000 }, turnEnd(21_000)], result.state);
        should(types(later.all)).not.containEql('send');
        should(later.state.phase).equal(stop.park.phase);
      });

      it('lands where it was asked when the take comes to nothing: the mic stays shut and nothing listens', () => {
        const result = run([{ type: 'turn-empty', attempt: 1 }], parked.state);
        landed(result.state, stop);
        should(result.state.words).equal('');
        should(result.state.shown).be.false();
        should(types(result.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'clearWords', 'closeMic']);
        should(types(result.effects)).not.containEql('resumeListening');
        should(result.state.notice).equal(null);
      });

      it('lands where it was asked when the take fails, and says so', () => {
        const result = run([{ type: 'turn-failed', attempt: 1, block: 'engine-failed' }], parked.state);
        landed(result.state, stop);
        should(result.state.notice).deepEqual({ kind: 'take-failed', block: 'engine-failed' });
        should(types(result.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'clearWords', 'closeMic']);
        should(types(result.effects)).not.containEql('resumeListening');
      });

      it('ignores the outcome of an attempt that is no longer current', () => {
        for (const event of [
          { type: 'turn-words', attempt: 9, atMs: 1, text: 'x' },
          { type: 'turn-empty', attempt: 9 },
          { type: 'turn-failed', attempt: 9, block: 'engine-failed' },
        ] as LiveEvent[])
          should(run([event], parked.state).state).equal(parked.state);
      });
    });
  }

  it('keeps the page-hidden fact when a stop was asked for first', () => {
    const typing = run([...SENDING, { type: 'typing' }, { type: 'visibility', visible: false }]);
    should(typing.state.park).deepEqual({ phase: 'hold', reason: 'typing' });
    should(typing.state.hidden).be.true();
  });
});

describe('liveReduce — Listening needs the microphone AND the lock', () => {
  const lock: LiveEvent = { type: 'locks', granted: true };
  const mic: LiveEvent = { type: 'listening' };

  it('stays starting until both have answered, in either order', () => {
    should(run([START, mic]).state.phase).equal('starting');
    should(run([START, lock]).state.phase).equal('starting');
    for (const order of [
      [mic, lock],
      [lock, mic],
    ]) {
      const result = run([START, ...order]);
      should(result.state.phase).equal('listening');
      should(result.effects).deepEqual([{ type: 'startTimer', kind: 'idle', ms: IDLE_END_MS }]);
    }
  });

  it('a lock refused after the microphone was ready ends Live: the second tab never listens', () => {
    const result = run([START, mic, { type: 'locks', granted: false }]);
    should(result.state.phase).equal('off');
    should(result.state.notice).deepEqual({ kind: 'blocked', block: 'other-tab' });
    should(types(result.effects)).containEql('closeMic');
    should(types(result.effects)).containEql('releaseLocks');
    should(types(result.all)).not.containEql('send');
  });

  it('a lock refused in EVERY other active phase ends Live too', () => {
    const phases: Record<string, LiveState> = {
      starting: run([START]).state,
      listening: run(LISTENING).state,
      hearing: run(HEARING).state,
      sending: run(SENDING).state,
      working: WORKING,
      reading: run([{ type: 'reply', signal: 'done' }], { ...WORKING, canRead: true }).state,
      hold: run([...LISTENING, { type: 'hold' }]).state,
      paused: run([...LISTENING, { type: 'visibility', visible: false }]).state,
    };
    for (const [name, state] of Object.entries(phases)) {
      const result = run([{ type: 'locks', granted: false }], state);
      should([name, result.state.phase]).deepEqual([name, 'off']);
      should(result.state.notice).deepEqual({ kind: 'blocked', block: 'other-tab' });
      should(types(result.effects)).containEql('closeMic');
    }
    should(run([{ type: 'locks', granted: false }]).state).equal(INITIAL_LIVE_STATE);
  });

  it('a hidden tab that opens its mic before the lock only pauses once both are in', () => {
    const hidden = { ...START, visible: false } as LiveEvent;
    should(run([hidden, mic]).state.phase).equal('starting');
    should(run([hidden, mic, lock]).state.phase).equal('paused');
  });

  it('Resume Live from a pause waits for the lock again, and the other ways back only wait for the mic', () => {
    const paused = run([...LISTENING, { type: 'visibility', visible: false }]).state;
    const back = run([{ type: 'visibility', visible: true }, { type: 'resume' }], paused);
    should(back.state.phase).equal('starting');
    should(run([mic], back.state).state.phase).equal('starting');
    should(run([mic, lock], back.state).state.phase).equal('listening');
    const held = run([...LISTENING, { type: 'hold' }, { type: 'resume' }]).state;
    should(run([mic], held).state.phase).equal('listening');
    const again = run([{ type: 'reply', signal: 'done' }], WORKING).state;
    should(run([mic], again).state.phase).equal('listening');
    const reading = run([{ type: 'reply', signal: 'done' }, { type: 'speak-done' }], { ...WORKING, canRead: true });
    should(run([mic], reading.state).state.phase).equal('listening');
  });
});

describe('liveReduce — totality', () => {
  const EVENTS: readonly LiveEvent[] = [
    START,
    { ...START, canSend: false } as LiveEvent,
    { type: 'locks', granted: true },
    { type: 'locks', granted: false },
    { type: 'listening' },
    { type: 'blocked', block: 'mic-blocked' },
    { type: 'speech-start' },
    { type: 'speech-cancel', atMs: 10 },
    turnEnd(),
    { type: 'live-words', text: 'x' },
    { type: 'turn-words', attempt: 1, atMs: 10, text: 'x' },
    { type: 'turn-empty', attempt: 1 },
    { type: 'turn-failed', attempt: 1, block: 'engine-failed' },
    { type: 'countdown-done', atMs: 10 },
    { type: 'timer', kind: 'settle', atMs: 10 },
    { type: 'timer', kind: 'idle', atMs: 10 },
    { type: 'hold' },
    { type: 'send-now', atMs: 10 },
    { type: 'resume' },
    { type: 'end' },
    { type: 'typing' },
    { type: 'visibility', visible: false },
    { type: 'visibility', visible: true },
    { type: 'sent', atMs: 10 },
    { type: 'send-failed' },
    { type: 'reply', signal: 'working' },
    { type: 'reply', signal: 'done' },
    { type: 'reply', signal: 'needs-input' },
    { type: 'reply', signal: 'ended' },
    { type: 'speak-done' },
    { type: 'skip' },
  ];
  const PHASES: Record<LivePhase, LiveState> = {
    off: INITIAL_LIVE_STATE,
    starting: run([START]).state,
    listening: run(LISTENING).state,
    hearing: run(HEARING).state,
    sending: run(WORDS).state,
    working: WORKING,
    reading: run([{ type: 'reply', signal: 'done' }], { ...WORKING, canRead: true }).state,
    hold: run([...LISTENING, { type: 'hold' }]).state,
    paused: run([...LISTENING, { type: 'visibility', visible: false }]).state,
  };
  const PARKED: Record<string, LiveState> = Object.fromEntries(
    STOPS.map(stop => [stop.name, run([...SENDING, stop.event]).state]),
  );

  it('answers every event in every phase with a well-formed step', () => {
    for (const [phase, state] of Object.entries(PHASES)) {
      should(state.phase).equal(phase);
      for (const event of EVENTS) {
        const result = liveReduce(state, event);
        should(result.state).be.an.Object();
        should(Array.isArray(result.effects)).be.true();
        should([
          'off',
          'starting',
          'listening',
          'hearing',
          'sending',
          'working',
          'reading',
          'hold',
          'paused',
        ]).containEql(result.state.phase);
      }
    }
  });

  it('never sends from a parked turn, whatever happens to it', () => {
    for (const state of Object.values(PARKED)) {
      should(state.park).not.equal(null);
      for (const event of EVENTS) {
        const next = liveReduce(state, event);
        should(types(next.effects)).not.containEql('send');
        // Nor in one more step after that — except the person's own "Send now" from the hold it landed in.
        for (const again of EVENTS) {
          if (again.type === 'send-now') continue;
          should(types(liveReduce(next.state, again).effects)).not.containEql('send');
        }
      }
    }
  });

  it('never sends from any phase but sending, and only after words were shown', () => {
    for (const [phase, state] of Object.entries(PHASES)) {
      for (const event of EVENTS) {
        const { effects } = liveReduce(state, event);
        if (!types(effects).includes('send')) continue;
        should(phase === 'sending' || (phase === 'hold' && event.type === 'send-now')).be.true();
        if (phase === 'sending') should(state.wordsReady || event.type === 'turn-words').be.true();
      }
    }
  });
});
