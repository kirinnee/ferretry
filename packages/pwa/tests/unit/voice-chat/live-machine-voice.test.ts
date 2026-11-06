/**
 * Proves the HALF-DUPLEX half of the Live reducer (F137 slice 5, fix round 1): the microphone opens only when NO
 * speech is playing from anywhere — Live's own reading or any other message on the page.
 *
 *   - a reading ended as `taken` (another message took the voice) is not the end of speech: the microphone stays shut and
 *     Live waits On hold (`speaking`); the speech ending later reopens nothing;
 *   - speech starting elsewhere while the microphone is open (or opening) closes it NOW — a turn mid-sentence is parked
 *     with its words kept — and every way back to listening checks the voice first;
 *   - Listen / Resume and Start are the person's say-so: the voice is cut first, then the microphone opens;
 *   - Live's own reading is never mistaken for someone else's.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  INITIAL_LIVE_STATE,
  type LiveEffect,
  type LiveEvent,
  type LiveState,
  liveReduce,
  micIsOpen,
} from '../../../src/lib/voice-chat/live-machine.ts';

interface Run {
  readonly state: LiveState;
  readonly effects: readonly LiveEffect[];
  readonly all: readonly LiveEffect[];
}
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

const START = { type: 'start', atMs: 0, canSend: true, visible: true, canRead: true } as const satisfies LiveEvent;
const LISTENING: readonly LiveEvent[] = [START, { type: 'locks', granted: true }, { type: 'listening' }];
const HEARING: readonly LiveEvent[] = [...LISTENING, { type: 'speech-start' }, { type: 'live-words', text: 'fix the' }];
const SENT: readonly LiveEvent[] = [
  ...LISTENING,
  { type: 'speech-start' },
  { type: 'live-words', text: 'fix the bug' },
  { type: 'turn-end', atMs: 5_000, speechEndedAtMs: 3_500, reason: 'pause' },
  { type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Fix the bug.' },
  { type: 'countdown-done', atMs: 6_500 },
  { type: 'sent', atMs: 6_600 },
];
const WORKING = run(SENT).state;
const READING = run([{ type: 'reply', signal: 'done' }], WORKING);
const ASKING = run([{ type: 'reply', signal: 'needs-input' }], WORKING);

describe('Live half-duplex — another message takes the voice while Live reads', () => {
  it('a reply reading ended `taken` is NOT the end of speech: On hold, microphone shut, nothing says it is safe to listen', () => {
    const taken = run([{ type: 'speak-done', id: 1, end: 'taken' }], READING.state);
    should(taken.state.phase).equal('hold');
    should(taken.state.holdReason).equal('speaking');
    should(taken.state.voiceBusy).be.true();
    should(taken.state.readKind).equal(null);
    should(micIsOpen(taken.state)).be.false();
    should(types(taken.effects)).deepEqual(['closeMic']);
    // The speech ending (the voice going idle) reopens nothing by itself...
    const quiet = run([{ type: 'voice', busy: false }], taken.state);
    should(quiet.state.phase).equal('hold');
    should(quiet.state.voiceBusy).be.false();
    should(quiet.all).deepEqual([]);
    // ...and Listen opens the microphone without needing to cut anything.
    const listen = run([{ type: 'resume' }], quiet.state);
    should(listen.state.phase).equal('starting');
    should(types(listen.effects)).deepEqual(['openMic']);
  });

  it('Listen while the other speech is still going cuts the voice FIRST, then opens the microphone', () => {
    const taken = run([{ type: 'speak-done', id: 1, end: 'taken' }], READING.state);
    const listen = run([{ type: 'resume' }], taken.state);
    should(listen.state.phase).equal('starting');
    should(listen.state.voiceBusy).be.false();
    should(types(listen.effects)).deepEqual(['silenceVoice', 'openMic']);
  });

  it('a question taken from Live still lands on its prompt, microphone shut', () => {
    const asking = run([{ type: 'speak-done', id: 1, end: 'taken' }], ASKING.state);
    should(asking.state.phase).equal('hold');
    should(asking.state.holdReason).equal('needs-input');
    should(asking.state.voiceBusy).be.true();
    should(micIsOpen(asking.state)).be.false();
    // Resume from there cuts the voice before it listens.
    should(types(run([{ type: 'resume' }], asking.state).effects)).deepEqual(['silenceVoice', 'openMic']);
  });

  it('a `stopped` end (the voice went quiet under the reading) is a plain stop: the voice is idle, Live listens', () => {
    const stopped = run([{ type: 'speak-done', id: 1, end: 'stopped' }], READING.state);
    should(stopped.state.phase).equal('starting');
    should(stopped.state.voiceBusy).be.false();
    should(types(stopped.effects)).deepEqual(['openMic']);
  });

  it('the voice events during Live\'s own reading are ignored: Live\'s own speech is not "someone else"', () => {
    for (const busy of [true, false]) {
      const next = run([{ type: 'voice', busy }], READING.state);
      should(next.state).equal(READING.state);
      should(next.effects).deepEqual([]);
    }
  });

  it('the voice events while Live is off change nothing', () => {
    should(run([{ type: 'voice', busy: true }]).state).equal(INITIAL_LIVE_STATE);
  });
});

describe('Live half-duplex — speech starting elsewhere while the microphone is open', () => {
  it('while listening: the microphone closes now and Live waits On hold', () => {
    const next = run([{ type: 'voice', busy: true }], run(LISTENING).state);
    should(next.state.phase).equal('hold');
    should(next.state.holdReason).equal('speaking');
    should(next.state.voiceBusy).be.true();
    should(types(next.effects)).deepEqual(['cancelCountdown', 'cancelTimers', 'closeMic']);
    should(micIsOpen(next.state)).be.false();
  });

  it('mid-sentence: the turn is parked with its words kept, never sent', () => {
    const next = run([{ type: 'voice', busy: true }], run(HEARING).state);
    should(next.state.phase).equal('sending');
    should(next.state.park).deepEqual({ phase: 'hold', reason: 'speaking' });
    should(types(next.effects)).containEql('stopCapture');
    should(types(next.effects)).not.containEql('send');
    const words = run([{ type: 'turn-words', attempt: 1, atMs: 1, text: 'Fix the bug.' }], next.state);
    should(words.state.phase).equal('hold');
    should(words.state.holdReason).equal('speaking');
    should(words.state.words).equal('Fix the bug.');
    should(types(words.effects)).not.containEql('send');
  });

  it('while the microphone is still opening: it is closed and Live holds', () => {
    const starting = run([START]).state;
    const next = run([{ type: 'voice', busy: true }], starting);
    should(next.state.phase).equal('hold');
    should(next.state.holdReason).equal('speaking');
    should(types(next.effects)).deepEqual(['cancelTimers', 'closeMic']);
    // The microphone opening afterwards, or the lock arriving, changes nothing.
    should(run([{ type: 'listening' }, { type: 'locks', granted: true }], next.state).state.phase).equal('hold');
  });

  it('while a message is on the wire (the mic is already shut), it is only remembered', () => {
    const inFlight = run([...SENT.slice(0, -1)]).state;
    should(inFlight.sendInFlight).be.true();
    const next = run([{ type: 'voice', busy: true }], inFlight);
    should(next.state.phase).equal('sending');
    should(next.state.voiceBusy).be.true();
    should(next.effects).deepEqual([]);
  });

  it('while the ferret works: remembered, and the finished reply is then NOT listened for over the speech', () => {
    const busy = run([{ type: 'voice', busy: true }], WORKING);
    should(busy.state.phase).equal('working');
    should(busy.state.voiceBusy).be.true();
    // A device that cannot read: the reply ends, the microphone must not open under the other speech.
    const noReader = run([{ type: 'reply', signal: 'done' }], { ...busy.state, canRead: false });
    should(noReader.state.phase).equal('hold');
    should(noReader.state.holdReason).equal('speaking');
    should(types(noReader.effects)).deepEqual(['stopWatchReply', 'closeMic']);
    // A device that can: Live takes the voice for its own reading (replacing the other), and owns it.
    const reader = run([{ type: 'reply', signal: 'done' }], { ...busy.state, canRead: true });
    should(reader.state.phase).equal('reading');
    should(reader.state.voiceBusy).be.false();
  });

  it('typing outranks the voice after a reply, and an idle voice is just recorded', () => {
    const typed = run([{ type: 'typing' }, { type: 'voice', busy: true }, { type: 'reply', signal: 'done' }], {
      ...WORKING,
      canRead: false,
    });
    should(typed.state.phase).equal('hold');
    should(typed.state.holdReason).equal('typing');
    const idle = run([{ type: 'voice', busy: false }], WORKING);
    should(idle.state.voiceBusy).be.false();
    should(idle.effects).deepEqual([]);
  });

  it('paused (hidden) and On hold wait too: Resume cuts the voice before the microphone opens, with a fresh lock ask when needed', () => {
    const held = run([{ type: 'hold' }, { type: 'voice', busy: true }], run(LISTENING).state);
    should(held.state.phase).equal('hold');
    should(held.state.voiceBusy).be.true();
    should(types(run([{ type: 'resume' }], held.state).effects)).deepEqual(['silenceVoice', 'openMic']);
    const away = run(
      [
        { type: 'visibility', visible: false },
        { type: 'voice', busy: true },
      ],
      run(LISTENING).state,
    );
    should(away.state.phase).equal('paused');
    const back = run([{ type: 'visibility', visible: true }, { type: 'resume' }], away.state);
    should(types(back.effects)).deepEqual(['silenceVoice', 'acquireLocks', 'openMic']);
    should(back.state.voiceBusy).be.false();
  });
});

describe('Live half-duplex — starting Live', () => {
  it('while something is speaking, the voice is cut before the microphone opens', () => {
    const next = run([{ ...START, voiceBusy: true }]);
    should(next.state.phase).equal('starting');
    should(types(next.effects)).deepEqual(['silenceVoice', 'acquireLocks', 'openMic']);
  });

  it('with a quiet page, nothing is cut', () => {
    should(types(run([{ ...START, voiceBusy: false }]).effects)).deepEqual(['acquireLocks', 'openMic']);
    should(types(run([START]).effects)).deepEqual(['acquireLocks', 'openMic']);
  });
});
