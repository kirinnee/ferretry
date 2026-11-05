/**
 * Proves what the Live bar says: the state in words for every phase, the ring and its seconds, the
 * controls offered in each state, the copy for every refusal, and the keys.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  INITIAL_LIVE_STATE,
  type LiveEvent,
  type LiveState,
  liveReduce,
} from '../../../src/lib/voice-chat/live-machine.ts';
import {
  LIVE_BLOCK_COPY,
  LIVE_TAKE_FAILED_COPY,
  liveKeyAction,
  liveView,
  noticeCopy,
} from '../../../src/lib/voice-chat/live-view.ts';
import type { LiveBlock } from '../../../src/lib/voice-chat/ports.ts';

const run = (events: readonly LiveEvent[], from: LiveState = INITIAL_LIVE_STATE): LiveState =>
  events.reduce((state, event) => liveReduce(state, event).state, from);

const LISTENING: readonly LiveEvent[] = [
  { type: 'start', atMs: 0, canSend: true, visible: true },
  { type: 'listening' },
];
const HEARING: readonly LiveEvent[] = [...LISTENING, { type: 'speech-start' }, { type: 'live-words', text: 'fix it' }];
const SENDING: readonly LiveEvent[] = [
  ...HEARING,
  { type: 'turn-end', atMs: 5_000, speechEndedAtMs: 3_500, reason: 'pause' },
];
const WORDS: readonly LiveEvent[] = [...SENDING, { type: 'turn-words', attempt: 1, atMs: 5_300, text: 'Fix it.' }];

describe('liveView — what the bar says in each state', () => {
  it('is hidden while Live is off, and says why when it refused', () => {
    should(liveView(INITIAL_LIVE_STATE, 0).visible).be.false();
    should(liveView(INITIAL_LIVE_STATE, 0).canEnd).be.false();
    const refused = liveView(
      run([
        { type: 'start', atMs: 0, canSend: true, visible: true },
        { type: 'locks', granted: false },
      ]),
      0,
    );
    should(refused.visible).be.true();
    should(refused.detail).equal(LIVE_BLOCK_COPY['other-tab']);
    should(refused.tone).equal('warn');
  });

  it('says Starting, Listening and Hearing you, with the live words only while hearing', () => {
    const starting = liveView(run([LISTENING[0] as LiveEvent]), 0);
    should(starting.stateWord).equal('Starting…');
    should(starting.big.action).equal('none');
    const listening = liveView(run(LISTENING), 0);
    should(listening.stateWord).equal('Listening');
    should(listening.micOpen).be.true();
    should(listening.canHold).be.true();
    should(listening.canSendNow).be.false();
    should(listening.liveWords).equal('');
    const hearing = liveView(run(HEARING), 0);
    should(hearing.stateWord).equal('Hearing you');
    should(hearing.liveWords).equal('fix it');
    should(hearing.canSendNow).be.true();
    should(hearing.big).deepEqual({ label: 'Hearing you', action: 'hold' });
  });

  it('shows a take that failed as a notice under Listening', () => {
    const view = liveView(run([...SENDING, { type: 'turn-failed', attempt: 1, block: 'engine-failed' }]), 0);
    should(view.stateWord).equal('Listening');
    should(view.detail).equal(LIVE_TAKE_FAILED_COPY);
    should(view.tone).equal('warn');
  });

  it('counts the ring down in whole seconds and fills it', () => {
    const sending = run(WORDS);
    const start = liveView(sending, 5_000);
    should(start.stateWord).equal('Sending in 2 s');
    should(start.ring).deepEqual({ progress: 0, secondsLeft: 2 });
    should(start.big).deepEqual({ label: 'Hold', action: 'hold' });
    should(start.canHold && start.canSendNow).be.true();
    const mid = liveView(sending, 5_750);
    should(mid.stateWord).equal('Sending in 1 s');
    should(mid.ring?.progress).equal(0.5);
    should(liveView(sending, 99_000).ring?.progress).equal(1);
    should(liveView(sending, 1_000).ring?.progress).equal(0);
  });

  it('says it is getting the words when the ring is done and they are not here', () => {
    should(liveView(run(SENDING), 6_600).stateWord).equal('Getting your words…');
    const noRing = run([
      { type: 'start', atMs: 0, canSend: true, visible: true, graceMs: 0 },
      { type: 'listening' },
      { type: 'speech-start' },
      { type: 'turn-end', atMs: 5_000, speechEndedAtMs: 4_000, reason: 'pause' },
    ]);
    should(liveView(noRing, 5_100).stateWord).equal('Getting your words…');
    should(liveView(noRing, 5_100).ring).equal(null);
  });

  it('says Sending… for the settle time and while the message is on the wire', () => {
    const settle = run([...WORDS, { type: 'countdown-done', atMs: 5_400 }]);
    should(liveView(settle, 5_400).stateWord).equal('Sending…');
    const flying = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }]);
    const view = liveView(flying, 6_500);
    should(view.stateWord).equal('Sending…');
    should(view.big.action).equal('none');
    should(view.canHold).be.false();
    should(view.micOpen).be.false();
  });

  it('offers nothing to change while the words are being worked out for a pause', () => {
    const parked = liveView(run([...SENDING, { type: 'typing' }]), 5_100);
    should(parked.stateWord).equal('Getting your words…');
    should(parked.ring).equal(null);
    should(parked.canHold).be.false();
    should(parked.canSendNow).be.false();
    should(parked.canEnd).be.true();
  });

  it('shows Working with the elapsed time, minutes included', () => {
    const working = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'sent', atMs: 6_600 }]);
    should(liveView(working, 18_700).stateWord).equal('Working 0:12');
    should(liveView(working, 18_700).workingSeconds).equal(12);
    should(liveView(working, 6_600 + 252_000).stateWord).equal('Working 4:12');
    should(liveView(working, 100).workingSeconds).equal(0);
    should(liveView({ ...working, sentAtMs: null }, 100).stateWord).equal('Working 0:00');
  });

  it('shows Reading with a Stop reading button', () => {
    const working = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'sent', atMs: 6_600 }]);
    const reading = run([{ type: 'reply', signal: 'done' }], { ...working, canRead: true });
    should(reading.phase).equal('reading');
    const speaking = liveView(reading, 0);
    should(speaking.stateWord).equal('Reading reply');
    should(speaking.big).deepEqual({ label: 'Stop reading', action: 'skip' });
  });

  it('shows each reason for a hold, with Resume and the right Send now', () => {
    const held = run([...WORDS, { type: 'hold' }]);
    const user = liveView(held, 0);
    should(user.stateWord).equal('On hold');
    should(user.detail).equal('Your words are in the composer. Resume, or send them.');
    should(user.big).deepEqual({ label: 'Resume', action: 'resume' });
    should(user.canResume && user.canSendNow).be.true();
    const typing = liveView(run([...WORDS, { type: 'typing' }]), 0);
    should(typing.detail).equal('Paused while you type. Resume when you are ready.');
    const failed = liveView(run([...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'send-failed' }]), 0);
    should(failed.detail).equal("Couldn't send. Your words are in the composer.");
    should(failed.tone).equal('error');
    const question = liveView(
      run([
        ...WORDS,
        { type: 'countdown-done', atMs: 6_500 },
        { type: 'sent', atMs: 6_600 },
        { type: 'reply', signal: 'needs-input' },
      ]),
      0,
    );
    should(question.detail).equal('Ferret needs your answer.');
    should(question.canSendNow).be.false();
  });

  it('offers Send now in a hold only when there is something to send', () => {
    const empty = run([...LISTENING, { type: 'hold' }]);
    should(liveView(empty, 0).canSendNow).be.false();
    should(liveView(empty, 0, true).canSendNow).be.true();
  });

  it('shows a pause with Resume Live, offered only once the page is back', () => {
    const away = run([...LISTENING, { type: 'visibility', visible: false }]);
    const hidden = liveView(away, 0);
    should(hidden.stateWord).equal('Paused');
    should(hidden.detail).equal('Live paused while away. Resume?');
    should(hidden.big).deepEqual({ label: 'Resume Live', action: 'resume' });
    should(hidden.canResume).be.false();
    should(liveView(run([{ type: 'visibility', visible: true }], away), 0).canResume).be.true();
  });
});

describe('noticeCopy', () => {
  it('has words for every block, take failure and way Live ends', () => {
    const blocks: LiveBlock[] = [
      'mic-blocked',
      'engine-not-chosen',
      'engine-missing',
      'engine-failed',
      'no-send-rights',
      'other-tab',
      'ios-browser-voice',
    ];
    for (const block of blocks) should(noticeCopy({ kind: 'blocked', block })).equal(LIVE_BLOCK_COPY[block]);
    should(LIVE_BLOCK_COPY['mic-blocked']).equal('Microphone is blocked for this site. Allow it, then press Live.');
    should(noticeCopy({ kind: 'take-failed', block: 'engine-failed' })).equal(LIVE_TAKE_FAILED_COPY);
    should(noticeCopy({ kind: 'ended', why: 'idle' })).equal('Live ended after ten minutes of quiet.');
    should(noticeCopy({ kind: 'ended', why: 'ferret-stopped' })).equal('Ferret stopped. Live ended.');
  });
});

describe('liveKeyAction', () => {
  it('maps Esc, Enter, H and Space only where the control is offered', () => {
    const sending = liveView(run(WORDS), 5_000);
    should(liveKeyAction('Escape', sending)).equal('end');
    should(liveKeyAction('Enter', sending)).equal('send-now');
    should(liveKeyAction('h', sending)).equal('hold');
    should(liveKeyAction('H', sending)).equal('hold');
    should(liveKeyAction(' ', sending)).equal(null);
    should(liveKeyAction('x', sending)).equal(null);
    const held = liveView(run([...WORDS, { type: 'hold' }]), 0);
    should(liveKeyAction(' ', held)).equal('resume');
    should(liveKeyAction('Spacebar', held)).equal('resume');
    should(liveKeyAction('h', held)).equal(null);
    const reading = liveView({ ...run(WORDS), phase: 'reading' }, 0);
    should(liveKeyAction(' ', reading)).equal('skip');
    const listening = liveView(run(LISTENING), 0);
    should(liveKeyAction('Enter', listening)).equal(null);
  });

  it('maps nothing while Live is off or the bar has no End', () => {
    const off = liveView(INITIAL_LIVE_STATE, 0);
    should(liveKeyAction('Escape', off)).equal(null);
    const refused = liveView(run([{ type: 'start', atMs: 0, canSend: false, visible: true }]), 0);
    should(liveKeyAction('Escape', refused)).equal(null);
    const noEnd = { ...liveView(run(LISTENING), 0), canEnd: false };
    should(liveKeyAction('Escape', noEnd)).equal(null);
  });
});

describe('liveView — the last turn', () => {
  it('says how long the last message took under Working, and nothing before there is one', () => {
    const working = run([...WORDS, { type: 'countdown-done', atMs: 6_500 }, { type: 'sent', atMs: 6_600 }]);
    should(liveView(working, 7_000).detail).equal(null);
    const last = {
      turn: 1,
      endReason: 'pause' as const,
      endToWordsMs: 300,
      graceMs: 1_500,
      endToSendMs: 1_600,
      lastWordToSentMs: 3_100,
      resumed: false,
      sendNow: false,
    };
    should(liveView(working, 7_000, false, last).detail).equal('Sent 3.1 s after your last word.');
  });
});
