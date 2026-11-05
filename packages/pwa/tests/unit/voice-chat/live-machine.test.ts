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
  NO_COUNTDOWN_MS,
  resolveCountdownMs,
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

  it('SAFEGUARD: only the exact number 0 is "no countdown"; a bad or tiny length lands in 0.5–5 s and never at 0', () => {
    should(NO_COUNTDOWN_MS).equal(0);
    should(GRACE_RANGE_MS).deepEqual({ min: 500, max: 5_000 });
    should(resolveGraceMs(0)).equal(0);
    for (const bad of [-40, -0.1, 0.1, 0.49, 1, 499, -1e9]) {
      should(resolveGraceMs(bad)).equal(GRACE_RANGE_MS.min);
      should(resolveCountdownMs(bad)).equal(GRACE_RANGE_MS.min);
    }
    for (const huge of [5_001, 99_999, 1e12]) should(resolveGraceMs(huge)).equal(GRACE_RANGE_MS.max);
    for (const junk of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '0',
      '-40',
      '',
      null,
      undefined,
      false,
      [],
      {},
    ]) {
      should(resolveGraceMs(junk)).equal(DEFAULT_GRACE_MS);
      should(resolveCountdownMs(junk)).equal(DEFAULT_GRACE_MS);
    }
    // The countdown a person can pick is never zero, even when asked for it; the machine keeps 0 only when it is handed 0.
    should(resolveCountdownMs(0)).equal(GRACE_RANGE_MS.min);
    // A start event carrying a damaged length gets a real countdown, not an immediate send.
    for (const bad of [-40, -0.1, 0.1]) {
      const started = run([{ ...START, graceMs: bad } as LiveEvent]).state;
      should(started.graceMs).equal(GRACE_RANGE_MS.min);
    }
    should(run([{ ...START, graceMs: 0 } as LiveEvent]).state.graceMs).equal(0);
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

  it('Hold or typing while listening closes the microphone at once (nothing was said)', () => {
    const held = run([...LISTENING, { type: 'hold' }]);
    should(held.state.phase).equal('hold');
    should(held.state.holdReason).equal('user');
    should(types(held.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'closeMic']);
    const listening = run([...LISTENING, { type: 'typing' }]);
    should(listening.state.holdReason).equal('typing');
  });

  it('Hold while hearing keeps the whole utterance: its words are worked out and land On hold, never discarded', () => {
    const held = run([...HEARING, { type: 'hold' }]);
    should(held.state.phase).equal('sending');
    should(held.state.park).deepEqual({ phase: 'hold', reason: 'user' });
    should(held.state.countdown).equal(null);
    should(held.state.attempt).equal(1);
    should(held.effects).deepEqual([
      { type: 'cancelCountdown' },
      { type: 'cancelTimers' },
      { type: 'showWords', text: 'fix the bug' },
      { type: 'beginTurnWords', attempt: 1 },
      { type: 'stopCapture' },
    ]);
    should(micIsOpen(held.state)).be.false();
    should(types(held.effects)).not.containEql('closeMic');
    should(types(held.effects)).not.containEql('startCountdown');
    const landed = run([{ type: 'turn-words', attempt: 1, atMs: 5_000, text: 'Fix the bug.' }], held.state);
    should(landed.state.phase).equal('hold');
    should(landed.state.words).equal('Fix the bug.');
    should(landed.effects).deepEqual([{ type: 'showWords', text: 'Fix the bug.' }, { type: 'closeMic' }]);
  });

  it('Hold while hearing without live words (a whole-take engine) shows no preview, and only the final words appear', () => {
    const hearing = run([...LISTENING, { type: 'speech-start' }]);
    const held = run([{ type: 'typing' }], hearing.state);
    should(types(held.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'beginTurnWords', 'stopCapture']);
    should(held.state.shown).be.false();
  });

  it('a hidden tab pauses a listening or counting down Live; words stay', () => {
    for (const events of [LISTENING, WORDS]) {
      const result = run([...events, { type: 'visibility', visible: false }]);
      should(result.state.phase).equal('paused');
      should(result.state.pauseReason).equal('hidden');
      should(result.state.hidden).be.true();
      should(types(result.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'closeMic']);
    }
    // Hearing keeps what was said: the words are worked out first, then the phase pauses.
    const hearing = run([...HEARING, { type: 'visibility', visible: false }]);
    should(hearing.state.phase).equal('sending');
    should(hearing.state.park).deepEqual({ phase: 'paused', reason: 'hidden' });
    should(hearing.state.hidden).be.true();
    const hearingArrived = run([{ type: 'turn-words', attempt: 1, atMs: 5_000, text: 'Fix the bug.' }], hearing.state);
    should(hearingArrived.state.phase).equal('paused');
    should(hearingArrived.state.words).equal('Fix the bug.');
    const parked = run([...SENDING, { type: 'visibility', visible: false }]);
    should(parked.state.park).deepEqual({ phase: 'paused', reason: 'hidden' });
    const arrived = run([{ type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Fix the bug.' }], parked.state);
    should(arrived.state.phase).equal('paused');
    should(arrived.state.words).equal('Fix the bug.');
  });

  it('visibility changes while holding, working or off only update the flag; coming back needs a tap', () => {
    const held = run([...LISTENING, { type: 'hold' }, { type: 'visibility', visible: false }]);
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
    should(reading.effects).deepEqual([{ type: 'stopWatchReply' }, { type: 'speak', what: 'reply', id: 1 }]);
    const finished = run([{ type: 'speak-done', id: 1, end: 'finished' }], reading.state);
    should(finished.state.phase).equal('starting');
    should(types(finished.effects)).deepEqual(['openMic']);
    const skipped = run([{ type: 'skip' }], reading.state);
    should(skipped.state.phase).equal('starting');
    should(types(skipped.effects)).deepEqual(['stopSpeaking', 'openMic']);
    // Typing or Hold stops the speech AT ONCE and stands until Resume: nothing reopens the mic behind a draft.
    const typed = run([{ type: 'typing' }], reading.state);
    should(typed.state.phase).equal('hold');
    should(typed.state.holdReason).equal('typing');
    should(types(typed.effects)).deepEqual(['stopSpeaking']);
    const held = run([{ type: 'hold' }], reading.state);
    should(held.state.phase).equal('hold');
    should(held.state.holdReason).equal('user');
    should(types(held.effects)).deepEqual(['stopSpeaking']);
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

describe('liveReduce — a stop in the middle of a spoken turn keeps what was said', () => {
  for (const stop of STOPS) {
    describe(stop.name, () => {
      const parked = run([...HEARING, stop.event]);

      it('finishes the turn into a sticky stop: no countdown, no send, capture stops at once', () => {
        should(parked.state.phase).equal('sending');
        should(parked.state.park).deepEqual(stop.park);
        should(parked.state.countdown).equal(null);
        should(parked.state.countdownElapsed).be.false();
        should(parked.state.sendWhenReady).be.false();
        should(micIsOpen(parked.state)).be.false();
        should(types(parked.effects)).deepEqual([
          'cancelCountdown',
          'cancelTimers',
          'showWords',
          'beginTurnWords',
          'stopCapture',
        ]);
      });

      it('puts the words in the box and lands where it was asked, with the microphone shut', () => {
        const result = run([{ type: 'turn-words', attempt: 1, atMs: 9_000, text: 'Fix the bug.' }], parked.state);
        landed(result.state, stop);
        should(result.state.words).equal('Fix the bug.');
        should(result.state.shown).be.true();
        should(result.effects).deepEqual([{ type: 'showWords', text: 'Fix the bug.' }, { type: 'closeMic' }]);
      });

      it('lands quietly, taking the preview out, when nothing came of the words', () => {
        for (const event of [
          { type: 'turn-empty', attempt: 1 },
          { type: 'turn-failed', attempt: 1, block: 'engine-failed' },
        ] as LiveEvent[]) {
          const result = run([event], parked.state);
          landed(result.state, stop);
          should(types(result.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'clearWords', 'closeMic']);
        }
      });

      it('cannot be revived by renewed speech, a pause, a timer or the countdown', () => {
        const result = run(
          [
            { type: 'speech-start' },
            turnEnd(8_000),
            { type: 'countdown-done', atMs: 9_500 },
            { type: 'timer', kind: 'settle', atMs: 10_000 },
          ],
          parked.state,
        );
        should(result.state).deepEqual(parked.state);
        should(result.all).deepEqual([]);
      });
    });
  }
});

describe('liveReduce — typing is a hold that outlasts the reply (the surprise-send rule)', () => {
  const typedWhile = (state: LiveState): LiveState => run([{ type: 'typing' }], state).state;

  it('typing while the ferret works keeps the reply watch and remembers the hold', () => {
    const typing = run([{ type: 'typing' }], WORKING);
    should(typing.state.phase).equal('working');
    should(typing.state.typingHold).be.true();
    should(typing.effects).deepEqual([]);
  });

  it('a reply that finishes after typing lands On hold: the mic stays shut and nothing listens until Resume', () => {
    const done = run([{ type: 'reply', signal: 'done' }], typedWhile(WORKING));
    should(done.state.phase).equal('hold');
    should(done.state.holdReason).equal('typing');
    should(types(done.effects)).deepEqual(['stopWatchReply']);
    should(micIsOpen(done.state)).be.false();
    // Nothing the room says reopens it, and nothing sends by itself.
    const noise = run(
      [
        { type: 'listening' },
        { type: 'speech-start' },
        turnEnd(),
        { type: 'countdown-done', atMs: 9_000 },
        { type: 'timer', kind: 'settle', atMs: 9_500 },
      ],
      done.state,
    );
    should(noise.state).deepEqual(done.state);
    should(noise.all).deepEqual([]);
    // The person's Resume is the one thing that reopens the microphone, and it forgets the hold.
    const resumed = run([{ type: 'resume' }], done.state);
    should(resumed.state.phase).equal('starting');
    should(resumed.state.typingHold).be.false();
    should(types(resumed.effects)).deepEqual(['openMic']);
    should(run([{ type: 'listening' }], resumed.state).state.phase).equal('listening');
  });

  it('typing while the send is on the wire changes nothing (the text left in the box is caught when the next turn would count down)', () => {
    const inFlight = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }]).state;
    should(inFlight.sendInFlight).be.true();
    should(run([{ type: 'typing' }], inFlight).state).equal(inFlight);
  });

  it('a needs-input reply is still a hold for the question, and Resume forgets the typing', () => {
    const asked = run([{ type: 'reply', signal: 'needs-input' }], typedWhile(WORKING));
    should(asked.state.holdReason).equal('needs-input');
    should(run([{ type: 'resume' }], asked.state).state.typingHold).be.false();
  });

  it('a hidden tab still pauses (Resume Live starts fresh and forgets the typing)', () => {
    const away = run(
      [
        { type: 'visibility', visible: false },
        { type: 'reply', signal: 'done' },
      ],
      typedWhile(WORKING),
    );
    should(away.state.phase).equal('paused');
    const back = run([{ type: 'visibility', visible: true }, { type: 'resume' }], away.state);
    should(back.state.phase).equal('starting');
    should(back.state.typingHold).be.false();
  });

  it('with a speaker the reply is still read, and the end of the reading lands On hold instead of listening', () => {
    const base = { ...WORKING, canRead: true };
    const reading = run([{ type: 'reply', signal: 'done' }], typedWhile(base));
    should(reading.state.phase).equal('reading');
    should(types(reading.effects)).deepEqual(['stopWatchReply', 'speak']);
    for (const [event, effects] of [
      [{ type: 'speak-done', id: 1, end: 'finished' }, []],
      [{ type: 'skip' }, ['stopSpeaking']],
    ] as const) {
      const done = run([event], reading.state);
      should(done.state.phase).equal('hold');
      should(done.state.holdReason).equal('typing');
      should(types(done.effects)).deepEqual(effects);
    }
    // Typing while it is being read stops the speech AT ONCE and stands until Resume: nothing waits for the end.
    const readThenTyped = run([{ type: 'reply', signal: 'done' }, { type: 'typing' }], base);
    should(readThenTyped.state.phase).equal('hold');
    should(readThenTyped.state.holdReason).equal('typing');
    should(types(readThenTyped.effects)).deepEqual(['stopSpeaking']);
    // ...and the speech ending afterwards (the stopped reading answering late) changes nothing.
    const late = run([{ type: 'speak-done', id: 1, end: 'stopped' }], readThenTyped.state);
    should(late.state).equal(readThenTyped.state);
  });

  it('typing while Live is still starting is a hold at once: the microphone being opened is closed, nothing listens', () => {
    const typing = run([START, { type: 'typing' }]);
    should(typing.state.phase).equal('hold');
    should(typing.state.holdReason).equal('typing');
    should(types(typing.effects)).deepEqual(['cancelTimers', 'closeMic']);
    // The late answers of the start change nothing.
    const late = run([{ type: 'listening' }], typing.state);
    should(late.state).equal(typing.state);
    should(micIsOpen(late.state)).be.false();
  });

  it('the lock that arrives after that is remembered, so Resume only reopens the microphone', () => {
    const typing = run([START, { type: 'typing' }, { type: 'locks', granted: true }]).state;
    should(typing.lockReady).be.true();
    const resumed = run([{ type: 'resume' }], typing);
    should(resumed.state.phase).equal('starting');
    should(types(resumed.effects)).deepEqual(['openMic']);
  });

  it('a typing hold whose lock never arrived asks for the lock again on Resume', () => {
    const typing = run([START, { type: 'typing' }]).state;
    should(typing.lockReady).be.false();
    const resumed = run([{ type: 'resume' }], typing);
    should(resumed.state.phase).equal('starting');
    should(resumed.state.lockReady).be.false();
    should(types(resumed.effects)).deepEqual(['acquireLocks', 'openMic']);
    // The lock refused while it was held still ends Live.
    should(run([{ type: 'locks', granted: false }], typing).state.phase).equal('off');
  });

  it('text in the box that Live did not put there stops a turn from ever counting down or sending', () => {
    for (const reason of ['pause', 'engine-hint', 'max-turn'] as const) {
      const typed = run([...HEARING, { ...turnEnd(), reason, typed: true } as LiveEvent]);
      should(typed.state.phase).equal('sending');
      should(typed.state.park).deepEqual({ phase: 'hold', reason: 'typing' });
      should(types(typed.effects)).not.containEql('startCountdown');
      should(types(typed.effects)).deepEqual([
        'cancelCountdown',
        'cancelTimers',
        'showWords',
        'beginTurnWords',
        'stopCapture',
      ]);
      const landedWords = run([{ type: 'turn-words', attempt: 1, atMs: 6_000, text: 'Fix the bug.' }], typed.state);
      should(landedWords.state.phase).equal('hold');
      should(landedWords.state.holdReason).equal('typing');
      should(types(landedWords.all)).not.containEql('send');
    }
    // The same when the voice came back and the burst after it ended the turn again.
    const resumed = run([...SENDING, { type: 'speech-start' }, { type: 'speech-cancel', atMs: 7_000, typed: true }]);
    should(resumed.state.park).deepEqual({ phase: 'hold', reason: 'typing' });
    should(types(resumed.all)).not.containEql('send');
    // "Send now" is the person's own press: it is not held back.
    should(run([...HEARING, { type: 'send-now', atMs: 5_000 }]).state.sendWhenReady).be.true();
  });

  it('an empty box (typed false or absent) counts down as before', () => {
    for (const event of [turnEnd(), { ...turnEnd(), typed: false } as LiveEvent])
      should(types(run([...HEARING, event]).effects)).containEql('startCountdown');
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
    const reading = run(
      [
        { type: 'reply', signal: 'done' },
        { type: 'speak-done', id: 1, end: 'finished' },
      ],
      {
        ...WORKING,
        canRead: true,
      },
    );
    should(run([mic], reading.state).state.phase).equal('listening');
  });
});

describe('liveReduce — a send can be taken back until the composer starts it', () => {
  const IN_FLIGHT = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }]);

  it('the approved send is in flight with the words ready', () => {
    should(IN_FLIGHT.state.phase).equal('sending');
    should(IN_FLIGHT.state.sendInFlight).be.true();
    should(types(IN_FLIGHT.effects)).containEql('send');
  });

  it('send-withdrawn puts it back to "words ready, nothing sent"; the stop that follows lands where a stop in the ring does', () => {
    const withdrawn = run([{ type: 'send-withdrawn' }], IN_FLIGHT.state);
    should(withdrawn.state.sendInFlight).be.false();
    should(withdrawn.state.wordsReady).be.true();
    should(withdrawn.state.words).equal('Fix the bug.');
    should(withdrawn.effects).deepEqual([]);
    for (const [stop, landing] of [
      [{ type: 'hold' }, 'hold'],
      [{ type: 'typing' }, 'hold'],
      [{ type: 'visibility', visible: false }, 'paused'],
    ] as const) {
      const stopped = run([stop], withdrawn.state);
      should(stopped.state.phase).equal(landing);
      should(stopped.state.words).equal('Fix the bug.');
      should(stopped.state.shown).be.true();
      should(types(stopped.all)).not.containEql('send');
      should(types(stopped.effects)).containEql('closeMic');
    }
    // Nothing the room or the clock does sends it afterwards.
    for (const event of [
      { type: 'countdown-done', atMs: 7_000 },
      { type: 'timer', kind: 'settle', atMs: 7_000 },
    ] as const)
      should(types(run([event], withdrawn.state).effects)).not.containEql('send');
  });

  it('send-withdrawn means nothing when no send is in flight', () => {
    const state = run(WORDS).state;
    should(run([{ type: 'send-withdrawn' }], state).state).deepEqual(state);
  });
});

describe("liveReduce — the person pressing the composer's own Send", () => {
  const PRESS: LiveEvent = { type: 'person-send', atMs: 7_000 };
  const RETIRED: readonly string[] = ['cancelCountdown', 'cancelTimers', 'closeMic'];

  it('retires the attempt from every phase before a send: the send is in flight, the mic is shut, and Live sends nothing itself', () => {
    const phases: Record<string, LiveState> = {
      starting: run([START]).state,
      listening: run(LISTENING).state,
      hearing: run(HEARING).state,
      'sending (ring running, words not ready)': run(SENDING).state,
      'sending (words ready)': run(WORDS).state,
      hold: run([...LISTENING, { type: 'hold' }]).state,
      'hold (typing)': run([...LISTENING, { type: 'typing' }]).state,
      'parked turn': run([...SENDING, { type: 'hold' }]).state,
      paused: run([...LISTENING, { type: 'visibility', visible: false }]).state,
    };
    for (const [name, state] of Object.entries(phases)) {
      const pressed = run([PRESS], state);
      should(pressed.state.phase).equal('sending', name);
      should(pressed.state.sendInFlight).be.true(name);
      should(pressed.state.countdown).equal(null);
      should(pressed.state.park).equal(null);
      should(pressed.effects.map(effect => effect.type)).deepEqual([...RETIRED], name);
      should(micIsOpen(pressed.state)).be.false(name);
      // Late answers from the retired attempt are ignored: the decode, the ring, the settle timer.
      for (const late of [
        { type: 'turn-words', attempt: pressed.state.attempt, atMs: 7_100, text: 'Late words.' },
        { type: 'countdown-done', atMs: 8_000 },
        { type: 'timer', kind: 'settle', atMs: 8_000 },
        { type: 'speech-start' },
      ] as const) {
        const after = run([late], pressed.state);
        should(types(after.effects)).not.containEql('send');
        should(after.state.words).equal(pressed.state.words);
        should(after.state.sendInFlight).be.true();
      }
    }
  });

  it('goes the same way as a send: sent → working with the reply watched; a failure → On hold with the words kept', () => {
    const pressed = run([PRESS], run(WORDS).state);
    const sent = run([{ type: 'sent', atMs: 7_050 }], pressed.state);
    should(sent.state.phase).equal('working');
    should(types(sent.effects)).deepEqual(['recordTurn', 'watchReply']);
    const failed = run([{ type: 'send-failed' }], pressed.state);
    should(failed.state.phase).equal('hold');
    should(failed.state.holdReason).equal('send-failed');
    should(failed.state.words).equal('Fix the bug.');
  });

  it('changes nothing while the ferret works, when Live is off, or when its own send is already on the way', () => {
    for (const state of [INITIAL_LIVE_STATE, WORKING, run([...WORDS, { type: 'countdown-done', atMs: 6_500 }]).state]) {
      const pressed = liveReduce(state, PRESS);
      should(pressed.state).equal(state);
      should(pressed.effects).deepEqual([]);
    }
  });

  it('is never the reason Live sends', () => {
    for (const state of [
      run(LISTENING).state,
      run(HEARING).state,
      run(WORDS).state,
      run([...LISTENING, { type: 'hold' }]).state,
    ])
      should(types(liveReduce(state, PRESS).effects)).not.containEql('send');
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
    { ...turnEnd(), typed: true } as LiveEvent,
    { type: 'speech-cancel', atMs: 10, typed: true },
    { type: 'visibility', visible: false },
    { type: 'visibility', visible: true },
    { type: 'sent', atMs: 10 },
    { type: 'send-failed' },
    { type: 'reply', signal: 'working' },
    { type: 'reply', signal: 'done' },
    { type: 'reply', signal: 'needs-input' },
    { type: 'reply', signal: 'ended' },
    { type: 'speak-done', id: 1, end: 'finished' },
    { type: 'speak-done', id: 9, end: 'failed' },
    { type: 'skip' },
    { type: 'repeat' },
    { type: 'person-send', atMs: 10 },
    { type: 'send-withdrawn' },
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
    STOPS.flatMap(stop => [
      [stop.name, run([...SENDING, stop.event]).state],
      [`${stop.name} while hearing`, run([...HEARING, stop.event]).state],
    ]),
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
