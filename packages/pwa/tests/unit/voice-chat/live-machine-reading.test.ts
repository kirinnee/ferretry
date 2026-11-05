/**
 * Proves the READING half of the Live loop's reducer (F137 slice 5), as tables of events and effects:
 *
 *   - a finished turn is read with the microphone still closed, then Live listens again (the mic reopens by itself);
 *   - a question is read and Live then stops at the prompt: it never listens for sending, and no event accepts
 *     an approval by voice;
 *   - the interrupt (tap, Space, Esc, S → `skip`), Repeat, and the End that still works;
 *   - the races: a late end for a reading that was replaced, a message sent by hand while reading, the tab hiding
 *     while reading, speech that breaks or has no voice, a reply with nothing to read (no reader);
 *   - the iPhone fallback: after a reply Live waits for "Listen" instead of reopening the microphone alone, and an
 *     automatic reopen that is refused falls back to the same Listen.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  INITIAL_LIVE_STATE,
  type LiveEffect,
  type LiveEvent,
  type LivePhase,
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

describe('Live reading — a finished turn', () => {
  it('reads the reply with the microphone closed, then listens again by itself', () => {
    should(WORKING.phase).equal('working');
    should(WORKING.canRead).be.true();
    should(READING.state.phase).equal('reading');
    should(READING.state.readKind).equal('reply');
    should(READING.effects).deepEqual([{ type: 'stopWatchReply' }, { type: 'speak', what: 'reply', id: 1 }]);
    // Half-duplex: no state in which the microphone is open while the reply is spoken.
    should(micIsOpen(READING.state)).be.false();
    should(types(READING.effects)).not.containEql('openMic');

    const after = run([{ type: 'speak-done', id: 1, end: 'finished' }], READING.state);
    should(after.state.phase).equal('starting');
    should(types(after.effects)).deepEqual(['openMic']);
    should(after.state.readKind).equal(null);
    const listening = run([{ type: 'locks', granted: true }, { type: 'listening' }], after.state);
    should(listening.state.phase).equal('listening');
  });

  it('says "Reading" in the state and not a word of the reply (the machine never holds it)', () => {
    should(JSON.stringify(READING.state)).not.containEql('Fix the bug');
  });

  it('a device that cannot speak skips the reading and listens again', () => {
    const mute = run([{ ...START, canRead: false }, { type: 'locks', granted: true }, { type: 'listening' }]);
    should(mute.state.canRead).be.false();
    const working = run(SENT.slice(3), mute.state).state;
    const done = run([{ type: 'reply', signal: 'done' }], working);
    should(done.state.phase).equal('starting');
    should(types(done.effects)).deepEqual(['stopWatchReply', 'openMic']);
  });
});

describe('Live reading — the interrupt, Repeat and End', () => {
  it('a skip (tap, Space, Esc or S) stops the speech at once and Live listens again', () => {
    const stopped = run([{ type: 'skip' }], READING.state);
    should(stopped.state.phase).equal('starting');
    should(types(stopped.effects)).deepEqual(['stopSpeaking', 'openMic']);
    should(stopped.state.notice).equal(null);
  });

  it('Repeat reads the reply again under a NEW id, and the old reading answering late changes nothing', () => {
    const again = run([{ type: 'repeat' }], READING.state);
    should(again.state.phase).equal('reading');
    should(again.effects).deepEqual([{ type: 'stopSpeaking' }, { type: 'speak', what: 'reply', id: 2 }]);
    // The first reading hears `stopped` AFTER the repeat was asked: that must not end the new reading.
    const late = run([{ type: 'speak-done', id: 1, end: 'stopped' }], again.state);
    should(late.state).equal(again.state);
    should(late.effects).deepEqual([]);
    should(run([{ type: 'speak-done', id: 2, end: 'finished' }], again.state).state.phase).equal('starting');
  });

  it('End ends Live and stops the speech and releases everything', () => {
    const off = run([{ type: 'end' }], READING.state);
    should(off.state.phase).equal('off');
    should(types(off.effects)).containEql('stopSpeaking');
    should(types(off.effects)).containEql('releaseLocks');
  });

  it('typing, Hold, Send now and the voice are ignored while reading: only a tap or a key stops it', () => {
    for (const event of [
      { type: 'typing' },
      { type: 'hold' },
      { type: 'send-now', atMs: 1 },
      { type: 'speech-start' },
      { type: 'resume' },
      { type: 'turn-end', atMs: 1, speechEndedAtMs: 1, reason: 'pause' },
    ] as const) {
      const next = run([event], READING.state);
      should(next.state).equal(READING.state);
      should(next.effects).deepEqual([]);
    }
  });
});

describe('Live reading — races', () => {
  it('a message sent by hand while reading stops the old reading and follows the new turn', () => {
    const next = run([{ type: 'outside-send', atMs: 9_000 }], READING.state);
    should(next.state.phase).equal('working');
    should(next.state.sentAtMs).equal(9_000);
    should(types(next.effects)).deepEqual(['stopSpeaking', 'watchReply']);
    // The stopped reading answers late: nothing happens.
    const late = run([{ type: 'speak-done', id: 1, end: 'stopped' }], next.state);
    should(late.state).equal(next.state);
    // ...and the new turn is read in its turn, under a fresh id.
    const reply = run([{ type: 'reply', signal: 'done' }], next.state);
    should(reply.effects).deepEqual([{ type: 'stopWatchReply' }, { type: 'speak', what: 'reply', id: 2 }]);
  });

  it('a message sent by hand does nothing in any other phase', () => {
    for (const state of [WORKING, run(LISTENING).state, INITIAL_LIVE_STATE]) {
      should(run([{ type: 'outside-send', atMs: 1 }], state).state).equal(state);
    }
  });

  it('the tab hiding while a reply is read stops the speech and pauses; a late end changes nothing', () => {
    const away = run([{ type: 'visibility', visible: false }], READING.state);
    should(away.state.phase).equal('paused');
    should(away.state.readKind).equal(null);
    should(types(away.effects)).deepEqual(['stopSpeaking']);
    should(run([{ type: 'speak-done', id: 1, end: 'stopped' }], away.state).state).equal(away.state);
  });

  it('a reply that ends while the tab is hidden is not read on return', () => {
    const hidden = run([{ type: 'visibility', visible: false }], WORKING);
    const done = run([{ type: 'reply', signal: 'done' }], hidden.state);
    should(done.state.phase).equal('paused');
    should(types(done.effects)).not.containEql('speak');
  });

  it('speech that breaks is text only: a notice says so and Live keeps going', () => {
    const broke = run([{ type: 'speak-done', id: 1, end: 'failed' }], READING.state);
    should(broke.state.phase).equal('starting');
    should(broke.state.notice).deepEqual({ kind: 'read-failed', why: 'failed' });
    should(types(broke.effects)).deepEqual(['openMic']);
    // The notice survives to the first line of listening and is cleared by the next voice.
    const listening = run([{ type: 'locks', granted: true }, { type: 'listening' }], broke.state);
    should(listening.state.phase).equal('listening');
    should(listening.state.notice).deepEqual({ kind: 'read-failed', why: 'failed' });
    should(run([{ type: 'speech-start' }], listening.state).state.notice).equal(null);
  });

  it('no voice that stays on the device is text only too, with its own notice', () => {
    const none = run([{ type: 'speak-done', id: 1, end: 'unavailable' }], READING.state);
    should(none.state.phase).equal('starting');
    should(none.state.notice).deepEqual({ kind: 'read-failed', why: 'unavailable' });
  });

  it('another reading taking the voice (stopped, not by us) is the same as the speech ending', () => {
    const replaced = run([{ type: 'speak-done', id: 1, end: 'stopped' }], READING.state);
    should(replaced.state.phase).equal('starting');
    should(replaced.state.notice).equal(null);
  });

  it('a stale end (an unknown id) is ignored', () => {
    for (const id of [0, 2, 99, -1]) {
      should(run([{ type: 'speak-done', id, end: 'finished' }], READING.state).state).equal(READING.state);
    }
  });

  it('the ferret stopping while a reply is read ends Live and the speech', () => {
    const ended = run([{ type: 'reply', signal: 'ended' }], READING.state);
    should(ended.state.phase).equal('off');
    should(types(ended.effects)).containEql('stopSpeaking');
  });

  it('a long reply that was cut at the cap is just a speech that finished', () => {
    // The cap lives in the reader (docs/voice.md): to the loop a capped reading is one that ended.
    should(run([{ type: 'speak-done', id: 1, end: 'finished' }], READING.state).state.phase).equal('starting');
  });
});

describe('Live reading — a question', () => {
  it('is read, with the microphone closed, and the prompt is where Live stops', () => {
    should(ASKING.state.phase).equal('reading');
    should(ASKING.state.readKind).equal('question');
    should(ASKING.effects).deepEqual([{ type: 'stopWatchReply' }, { type: 'speak', what: 'question', id: 1 }]);
    should(micIsOpen(ASKING.state)).be.false();

    const read = run([{ type: 'speak-done', id: 1, end: 'finished' }], ASKING.state);
    should(read.state.phase).equal('hold');
    should(read.state.holdReason).equal('needs-input');
    should(types(read.effects)).not.containEql('openMic');
  });

  it('a skip, a broken voice or a hidden tab all land at the prompt, never on listening', () => {
    for (const event of [
      { type: 'skip' },
      { type: 'speak-done', id: 1, end: 'failed' },
      { type: 'speak-done', id: 1, end: 'unavailable' },
      { type: 'visibility', visible: false },
    ] as const) {
      const next = run([event], ASKING.state);
      should(next.state.phase).equal('hold');
      should(next.state.holdReason).equal('needs-input');
      should(types(next.effects)).not.containEql('openMic');
    }
  });

  it('Repeat reads the question again', () => {
    const again = run([{ type: 'repeat' }], ASKING.state);
    should(again.effects).deepEqual([{ type: 'stopSpeaking' }, { type: 'speak', what: 'question', id: 2 }]);
  });

  it('NEVER accepts an approval by voice: nothing sends from the question, the prompt or the Listen hold', () => {
    const prompt = run([{ type: 'speak-done', id: 1, end: 'finished' }], ASKING.state).state;
    const everything: readonly LiveEvent[] = [
      { type: 'speech-start' },
      { type: 'live-words', text: 'yes approve it' },
      { type: 'turn-end', atMs: 1, speechEndedAtMs: 1, reason: 'pause' },
      { type: 'turn-words', attempt: 1, atMs: 1, text: 'yes approve it' },
      { type: 'countdown-done', atMs: 1 },
      { type: 'timer', kind: 'settle', atMs: 1 },
      { type: 'send-now', atMs: 1 },
      { type: 'listening' },
    ];
    for (const state of [ASKING.state, prompt]) {
      for (const event of everything) {
        const next = liveReduce(state, event);
        should(types(next.effects)).not.containEql('send');
        should(next.state.phase === 'reading' || next.state.phase === 'hold').be.true();
      }
    }
  });

  it('with no voice, or a hidden tab, a question simply holds at the prompt', () => {
    const mute = run([{ type: 'reply', signal: 'needs-input' }], { ...WORKING, canRead: false });
    should(mute.state.phase).equal('hold');
    should(mute.state.holdReason).equal('needs-input');
    const hidden = run(
      [
        { type: 'visibility', visible: false },
        { type: 'reply', signal: 'needs-input' },
      ],
      WORKING,
    );
    should(hidden.state.holdReason).equal('needs-input');
    should(types(hidden.effects)).not.containEql('speak');
  });
});

describe('Live reading — the iPhone fallback (unproven on a real iPhone)', () => {
  const phone = run(
    SENT.slice(0, 0).concat([{ ...START, tapToListen: true }, { type: 'locks', granted: true }, { type: 'listening' }]),
  );
  const phoneWorking = run(SENT.slice(3), phone.state).state;

  it('after a read reply Live waits On "Listen" instead of opening the microphone by itself', () => {
    const reading = run([{ type: 'reply', signal: 'done' }], phoneWorking);
    const after = run([{ type: 'speak-done', id: 1, end: 'finished' }], reading.state);
    should(after.state.phase).equal('hold');
    should(after.state.holdReason).equal('listen');
    should(types(after.effects)).not.containEql('openMic');
    should(micIsOpen(after.state)).be.false();
    // The tap on Listen is a resume: it reopens the microphone, and that one is not "automatic".
    const tapped = run([{ type: 'resume' }], after.state);
    should(tapped.state.phase).equal('starting');
    should(tapped.state.autoReopen).be.false();
    should(types(tapped.effects)).deepEqual(['openMic']);
  });

  it('also for a reply that is not read (no voice) and for a skip', () => {
    const mute = run([{ type: 'reply', signal: 'done' }], { ...phoneWorking, canRead: false });
    should(mute.state.holdReason).equal('listen');
    const reading = run([{ type: 'reply', signal: 'done' }], phoneWorking);
    should(run([{ type: 'skip' }], reading.state).state.holdReason).equal('listen');
  });

  it('a microphone Live reopened by itself and was refused falls back to Listen, anywhere', () => {
    const reading = run(
      [
        { type: 'reply', signal: 'done' },
        { type: 'speak-done', id: 1, end: 'finished' },
      ],
      WORKING,
    );
    should(reading.state.autoReopen).be.true();
    const refused = run([{ type: 'blocked', block: 'mic-blocked' }], reading.state);
    should(refused.state.phase).equal('hold');
    should(refused.state.holdReason).equal('listen');
    should(types(refused.effects)).deepEqual(['closeMic']);
    // A refusal of the person's own tap is a real refusal.
    const tap = run([{ type: 'resume' }], refused.state);
    should(run([{ type: 'blocked', block: 'mic-blocked' }], tap.state).state.phase).equal('off');
    // And a refusal at the very first start is a real refusal too.
    should(run([START, { type: 'blocked', block: 'mic-blocked' }]).state.phase).equal('off');
  });

  it("Send now is still the person's own tap from the Listen hold, and nothing else sends", () => {
    const reading = run(
      [
        { type: 'reply', signal: 'done' },
        { type: 'speak-done', id: 1, end: 'finished' },
      ],
      phoneWorking,
    );
    const held = reading.state;
    should(
      types(run([{ type: 'speech-start' }, { type: 'timer', kind: 'idle', atMs: 1 }], held).effects),
    ).not.containEql('send');
  });
});

describe('Live reading — totality', () => {
  const EVENTS: readonly LiveEvent[] = [
    { type: 'speak-done', id: 1, end: 'finished' },
    { type: 'speak-done', id: 1, end: 'stopped' },
    { type: 'speak-done', id: 1, end: 'failed' },
    { type: 'speak-done', id: 1, end: 'unavailable' },
    { type: 'skip' },
    { type: 'repeat' },
    { type: 'outside-send', atMs: 5 },
    { type: 'resume' },
    { type: 'end' },
    { type: 'visibility', visible: false },
    { type: 'reply', signal: 'done' },
    { type: 'reply', signal: 'needs-input' },
  ];
  const STATES: Record<string, LiveState> = {
    off: INITIAL_LIVE_STATE,
    working: WORKING,
    reading: READING.state,
    asking: ASKING.state,
    listen: run(
      [{ type: 'speak-done', id: 1, end: 'finished' }],
      run([{ type: 'reply', signal: 'done' }], { ...WORKING, tapToListen: true }).state,
    ).state,
  };
  it('every reading event in every phase returns a well-formed step', () => {
    const phases: readonly LivePhase[] = [
      'off',
      'starting',
      'listening',
      'hearing',
      'sending',
      'working',
      'reading',
      'hold',
      'paused',
    ];
    for (const state of Object.values(STATES)) {
      for (const event of EVENTS) {
        const next = liveReduce(state, event);
        should(phases).containEql(next.state.phase);
        should(Array.isArray(next.effects)).be.true();
      }
    }
  });
});
