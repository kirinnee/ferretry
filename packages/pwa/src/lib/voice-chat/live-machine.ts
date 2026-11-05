/**
 * THE LIVE VOICE LOOP, as one pure reducer: `(state, event) → { state, effects }`.
 *
 * Live is the one place voice sends. This file is where "never surprise-send" is decided, so it is
 * pure and total: no timers, no ports, no `Date`; every event that matters carries its own time, and
 * every consequence in the world is an EFFECT the runner (`live-runner.ts`) performs and answers
 * with another event. A test feeds events and reads effects; nothing is faked because nothing is real.
 *
 * THE STATES (docs/voice.md › Live voice):
 *
 *   off → starting → listening ⇄ hearing → sending → working → listening …
 *                         │          │         │         └→ reading (slice 5) → listening
 *                         └──────────┴─────────┴→ hold (the person, typing, a failed send, a question)
 *                         └──────────┴─────────┴→ paused (the tab was hidden)
 *
 * THE RULES IT ENFORCES:
 *
 *   - A SEND HAPPENS ONLY FROM `sending`, after the turn's final words were put on screen: when the
 *     countdown has run AND the words have been visible for {@link SETTLE_MS}, or at once on "Send now".
 *     A countdown that finishes before the words are ready waits for them, then waits the settle time.
 *   - VOICE RETURNING DURING THE COUNTDOWN cancels it and everything the early finish produced: the
 *     attempt number advances, so a late answer from the cancelled attempt is ignored.
 *   - TYPING, HOLD AND A HIDDEN TAB each stop the auto-send and close the microphone; the words stay in the
 *     composer. If the words were still being worked out, the phase waits for them (`park`) so nothing said
 *     is lost — and that stop is STICKY: capture and level frames stop at once (`stopCapture`), renewed
 *     speech is ignored, and whatever the pending words turn out to be (words, nothing, a failure) the
 *     phase lands where the person put it, never back on listening and never on a send. NOTHING SENDS
 *     UNLESS THE VISIBLE COUNTDOWN ELAPSED IN AN UN-PARKED STATE.
 *   - LISTENING NEEDS BOTH THE MICROPHONE AND THE LOCK: `starting` becomes `listening` only once the mic is
 *     open (`listening` event) AND the one-Live-tab lock is granted (`locks`); a refusal of the lock ends Live
 *     in any phase.
 *   - A FAILED SEND is On hold with the words kept; nothing is retried by itself.
 *   - AN EMPTY OR NOISE TAKE goes quietly back to listening.
 *   - THE MICROPHONE IS OPEN ONLY WHILE `listening`, `hearing` or `sending` (until the send starts).
 *
 * READING (docs/voice.md › Live voice › Reading the reply):
 *
 *   - A turn that ends (`working` → `done`) is READ when the device can speak (`canRead`): phase `reading`, the
 *     microphone still CLOSED (half-duplex: it was shut when the message went), then listening again when the
 *     speech ends. A turn that stops on a QUESTION is read too (`readKind: 'question'`) and then lands On hold
 *     for the prompt on screen — Live never listens for an answer to it and has no way to accept one by voice.
 *   - Every reading has an id. An end that is not the current reading's (a stopped one answering late, after a
 *     Repeat) is ignored, so a late echo can never end the reading that replaced it.
 *   - ONLY A TAP OR A KEY STOPS A READING (`skip`): the microphone is not open to hear anything else.
 *   - A speech that breaks (`failed`) or has no voice that stays on the device (`unavailable`) is text only:
 *     the reply is on screen, a notice says so, and Live listens again.
 *   - `tapToListen` (an iPhone, where a page may not open the microphone without a tap) lands On hold with
 *     reason `listen` after each reply instead of reopening the microphone by itself; and when an automatic
 *     reopen is refused anywhere, the same Listen hold is the fallback.
 *   - A message sent BY HAND while a reply is being read (`outside-send`) stops the reading — it belongs to an
 *     older turn — and Live follows the new one.
 */

import type { LiveBlock, ReadEnd, ReadWhat } from './ports.ts';

/** The countdown between the end of a turn and the send, in ms. 0 sends as soon as the words are shown. */
export const DEFAULT_GRACE_MS = 1_500;
export const GRACE_RANGE_MS = Object.freeze({ min: 0, max: 5_000 });
/** The words must have been on screen this long before an automatic send (not "Send now"). */
export const SETTLE_MS = 500;
/** Ten minutes with no speech ends Live: a phone left on a desk is not a microphone left open. */
export const IDLE_END_MS = 600_000;

/** A grace length from anything: clamped to the range, rounded, garbage → the default. */
export function resolveGraceMs(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_GRACE_MS;
  return Math.min(GRACE_RANGE_MS.max, Math.max(GRACE_RANGE_MS.min, Math.round(input)));
}

export type LivePhase =
  | 'off'
  | 'starting'
  | 'listening'
  | 'hearing'
  | 'sending'
  | 'working'
  | 'reading'
  | 'hold'
  | 'paused';
type HoldReason = 'user' | 'typing' | 'send-failed' | 'needs-input' | 'listen';
type PauseReason = 'hidden';
/** Why a turn ended: the endpointer's rule, or the person's "Send now". */
type EndReason = 'pause' | 'engine-hint' | 'max-turn' | 'user';

/** What the bar says besides the state: a refusal to start, why Live ended, or a take that came to nothing. */
export type LiveNotice =
  | { readonly kind: 'blocked'; readonly block: LiveBlock }
  | { readonly kind: 'ended'; readonly why: 'idle' | 'ferret-stopped' }
  | { readonly kind: 'take-failed'; readonly block: LiveBlock }
  /** The reply could not be read aloud: it is on screen. */
  | { readonly kind: 'read-failed'; readonly why: 'failed' | 'unavailable' };

/** Where a phase waits to go once the words being worked out arrive. */
type Park =
  | { readonly phase: 'hold'; readonly reason: HoldReason }
  | { readonly phase: 'paused'; readonly reason: PauseReason };

export interface LiveState {
  readonly phase: LivePhase;
  readonly graceMs: number;
  readonly canRead: boolean;
  /** This device cannot reopen the microphone without a tap (an iPhone): after a reply, Live waits for "Listen". */
  readonly tapToListen: boolean;
  /** What is being read, in `reading`. */
  readonly readKind: ReadWhat | null;
  /** Which reading is current; an end for another is ignored. */
  readonly readId: number;
  /** The microphone is being reopened by Live itself (not by a tap): a refusal falls back to "Listen". */
  readonly autoReopen: boolean;
  /** The tab is hidden now (kept in every phase: a reply that lands while away pauses instead of listening). */
  readonly hidden: boolean;
  /** While `starting`: the microphone and the level meter are open. */
  readonly micReady: boolean;
  /** While `starting`: the one-Live-tab lock is ours. */
  readonly lockReady: boolean;
  /** Words heard so far this turn (live), or the turn's words once ready. */
  readonly words: string;
  /** The words are in the composer. */
  readonly shown: boolean;
  /** The endpointer's last loud frame of this turn, for the timeline. */
  readonly speechEndedAtMs: number | null;
  readonly endReason: EndReason | null;
  /** When the current end-of-turn attempt began (the ring starts here). */
  readonly endedAtMs: number | null;
  /** The ring: when it started and how long it runs. Null when none is running. */
  readonly countdown: { readonly startedAtMs: number; readonly durationMs: number } | null;
  readonly countdownElapsed: boolean;
  /** Which end-of-turn attempt is current; an answer for another is ignored. */
  readonly attempt: number;
  readonly wordsReady: boolean;
  readonly wordsReadyAtMs: number | null;
  /** "Send now" was pressed before the words were ready. */
  readonly sendWhenReady: boolean;
  readonly sendNow: boolean;
  /** The send is on the wire. */
  readonly sendInFlight: boolean;
  /** The voice came back during a countdown in this turn: a short burst afterwards ends it again. */
  readonly resumed: boolean;
  readonly park: Park | null;
  readonly holdReason: HoldReason | null;
  readonly pauseReason: PauseReason | null;
  readonly notice: LiveNotice | null;
  /** When the message in `working` was sent. */
  readonly sentAtMs: number | null;
  /** How many messages this Live session has sent. */
  readonly turn: number;
}

/** The numbers kept for each sent turn. Never words. */
export interface TurnNumbers {
  readonly turn: number;
  readonly endReason: EndReason;
  /** The end of the turn to the final words on screen. */
  readonly endToWordsMs: number;
  readonly graceMs: number;
  /** The end of the turn to the send starting. */
  readonly endToSendMs: number;
  /** The last loud frame to the message sent: what the person feels. */
  readonly lastWordToSentMs: number;
  readonly resumed: boolean;
  readonly sendNow: boolean;
}

type LiveTimerKind = 'settle' | 'idle';

/** What the world is asked to do. The machine never does any of it. */
export type LiveEffect =
  /** The mic lock (one Live tab) and the wake lock. */
  | { readonly type: 'acquireLocks' }
  | { readonly type: 'releaseLocks' }
  /** Open the take and the level meter. Synchronous from a tap, so the permission prompt is the gesture's. */
  | { readonly type: 'openMic' }
  | { readonly type: 'closeMic' }
  /** Stop hearing at once (level frames, the endpointer) but let the take's pending words arrive. */
  | { readonly type: 'stopCapture' }
  | { readonly type: 'beginTurnWords'; readonly attempt: number }
  /** Record on after an end-of-turn attempt came to nothing or the voice came back. */
  | { readonly type: 'resumeListening' }
  | { readonly type: 'startCountdown'; readonly ms: number }
  | { readonly type: 'cancelCountdown' }
  | { readonly type: 'startTimer'; readonly kind: LiveTimerKind; readonly ms: number }
  | { readonly type: 'cancelTimers' }
  | { readonly type: 'showWords'; readonly text: string }
  | { readonly type: 'clearWords' }
  | { readonly type: 'send' }
  | { readonly type: 'watchReply' }
  | { readonly type: 'stopWatchReply' }
  | { readonly type: 'speak'; readonly what: ReadWhat; readonly id: number }
  | { readonly type: 'stopSpeaking' }
  | { readonly type: 'recordTurn'; readonly numbers: TurnNumbers };

export type LiveEvent =
  | {
      readonly type: 'start';
      readonly atMs: number;
      readonly canSend: boolean;
      readonly visible: boolean;
      readonly graceMs?: unknown;
      readonly canRead?: boolean;
      readonly tapToListen?: boolean;
    }
  | { readonly type: 'locks'; readonly granted: boolean }
  | { readonly type: 'listening' }
  | { readonly type: 'blocked'; readonly block: LiveBlock }
  | { readonly type: 'speech-start' }
  | { readonly type: 'speech-cancel'; readonly atMs: number }
  | {
      readonly type: 'turn-end';
      readonly atMs: number;
      readonly speechEndedAtMs: number;
      readonly reason: 'pause' | 'engine-hint' | 'max-turn';
    }
  | { readonly type: 'live-words'; readonly text: string }
  | { readonly type: 'turn-words'; readonly attempt: number; readonly atMs: number; readonly text: string }
  | { readonly type: 'turn-empty'; readonly attempt: number }
  | { readonly type: 'turn-failed'; readonly attempt: number; readonly block: LiveBlock }
  | { readonly type: 'countdown-done'; readonly atMs: number }
  | { readonly type: 'timer'; readonly kind: LiveTimerKind; readonly atMs: number }
  | { readonly type: 'hold' }
  | { readonly type: 'send-now'; readonly atMs: number }
  | { readonly type: 'resume' }
  | { readonly type: 'end' }
  | { readonly type: 'typing' }
  | { readonly type: 'visibility'; readonly visible: boolean }
  | { readonly type: 'sent'; readonly atMs: number }
  | { readonly type: 'send-failed' }
  | { readonly type: 'reply'; readonly signal: 'working' | 'done' | 'needs-input' | 'ended' }
  /** A reading ended: `id` is the reading that ended and `end` how. */
  | { readonly type: 'speak-done'; readonly id: number; readonly end: ReadEnd }
  /** The person stopped the reading (tap, Space, Esc, S). */
  | { readonly type: 'skip' }
  | { readonly type: 'repeat' }
  /** A message was sent by hand (not by Live): a reading in progress belongs to an older turn. */
  | { readonly type: 'outside-send'; readonly atMs: number };

export interface LiveStep {
  readonly state: LiveState;
  readonly effects: readonly LiveEffect[];
}

export const INITIAL_LIVE_STATE: LiveState = Object.freeze({
  phase: 'off',
  graceMs: DEFAULT_GRACE_MS,
  canRead: false,
  tapToListen: false,
  readKind: null,
  readId: 0,
  autoReopen: false,
  hidden: false,
  micReady: false,
  lockReady: false,
  words: '',
  shown: false,
  speechEndedAtMs: null,
  endReason: null,
  endedAtMs: null,
  countdown: null,
  countdownElapsed: false,
  attempt: 0,
  wordsReady: false,
  wordsReadyAtMs: null,
  sendWhenReady: false,
  sendNow: false,
  sendInFlight: false,
  resumed: false,
  park: null,
  holdReason: null,
  pauseReason: null,
  notice: null,
  sentAtMs: null,
  turn: 0,
});

/** Everything a turn carries, reset when a new one begins. */
const FRESH_TURN = {
  words: '',
  shown: false,
  speechEndedAtMs: null,
  endReason: null,
  endedAtMs: null,
  countdown: null,
  countdownElapsed: false,
  wordsReady: false,
  wordsReadyAtMs: null,
  sendWhenReady: false,
  sendNow: false,
  sendInFlight: false,
  resumed: false,
  park: null,
  autoReopen: false,
} as const;

const CLOSE_ALL: readonly LiveEffect[] = [
  { type: 'cancelCountdown' },
  { type: 'cancelTimers' },
  { type: 'closeMic' },
  { type: 'stopWatchReply' },
  { type: 'stopSpeaking' },
  { type: 'releaseLocks' },
];

const step = (state: LiveState, effects: readonly LiveEffect[] = []): LiveStep => ({ state, effects });
const idleTimer: LiveEffect = { type: 'startTimer', kind: 'idle', ms: IDLE_END_MS };
/** A parked turn whose words came to nothing: the preview comes out, the mic shuts. */
const stoppedWithoutWords: readonly LiveEffect[] = [
  { type: 'cancelCountdown' },
  { type: 'cancelTimers' },
  { type: 'clearWords' },
  { type: 'closeMic' },
];

/** The phase for "microphone open, nothing heard yet". */
const toListening = (state: LiveState, extra: Partial<LiveState> = {}): LiveState => ({
  ...state,
  ...FRESH_TURN,
  ...extra,
  phase: 'listening',
  holdReason: null,
  pauseReason: null,
});

/** Live is over (or was refused): every effect that closes what was open. */
const toOff = (state: LiveState, notice: LiveNotice | null): LiveStep =>
  step(
    {
      ...INITIAL_LIVE_STATE,
      graceMs: state.graceMs,
      canRead: state.canRead,
      tapToListen: state.tapToListen,
      hidden: state.hidden,
      turn: state.turn,
      notice,
    },
    CLOSE_ALL,
  );

const MIC_OPEN_PHASES: readonly LivePhase[] = ['listening', 'hearing'];

/** Land on the phase a stop asked for: the mic is closed, the turn is over, `words` stay where they are. */
function landOn(state: LiveState, target: Park, words: string, shown: boolean, notice: LiveNotice | null): LiveState {
  const common = { ...state, ...FRESH_TURN, words, shown, countdown: null, park: null, notice };
  return target.phase === 'hold'
    ? { ...common, phase: 'hold', holdReason: target.reason, pauseReason: null }
    : { ...common, phase: 'paused', pauseReason: target.reason, holdReason: null };
}

/**
 * Stop the loop where it is: mic closed, words kept, the countdown and timers gone. While the words are still
 * being worked out the stop is remembered (`park`) and is STICKY: capture stops now, the first stop stands, and
 * the pending words land the phase there (see `reduceSending`).
 */
function park(state: LiveState, target: Park): LiveStep {
  const stop: LiveEffect[] = [{ type: 'cancelCountdown' }, { type: 'cancelTimers' }];
  if (state.phase === 'sending' && !state.wordsReady) {
    if (state.park !== null) return step(state);
    return step({ ...state, countdown: null, countdownElapsed: false, sendWhenReady: false, park: target }, [
      ...stop,
      { type: 'stopCapture' },
    ]);
  }
  return step(landOn(state, target, state.words, state.shown, state.notice), [...stop, { type: 'closeMic' }]);
}

/** Put the final words on screen and decide whether the send can go. */
function wordsArrived(state: LiveState, atMs: number, text: string): LiveStep {
  const shown: LiveEffect = { type: 'showWords', text };
  if (state.park !== null) return step(landOn(state, state.park, text, true, null), [shown, { type: 'closeMic' }]);
  const base = { ...state, words: text, shown: true, wordsReady: true, wordsReadyAtMs: atMs };
  if (state.sendWhenReady || (state.countdownElapsed && state.graceMs === 0)) return beginSend(base, [shown]);
  if (state.countdownElapsed) return step(base, [shown, { type: 'startTimer', kind: 'settle', ms: SETTLE_MS }]);
  return step(base, [shown]);
}

/** The send goes: mic closed, the message on the wire. The state stays `sending` until it is answered. */
function beginSend(state: LiveState, before: readonly LiveEffect[] = []): LiveStep {
  return step({ ...state, countdown: null, sendInFlight: true, sendWhenReady: false }, [
    ...before,
    { type: 'cancelCountdown' },
    { type: 'cancelTimers' },
    { type: 'closeMic' },
    { type: 'send' },
  ]);
}

/** The end of a turn: start working out the words and the ring. */
function endTurn(state: LiveState, atMs: number, speechEndedAtMs: number, reason: EndReason): LiveStep {
  const attempt = state.attempt + 1;
  const zero = state.graceMs === 0;
  const effects: LiveEffect[] = [{ type: 'cancelTimers' }];
  // What was heard so far goes on screen at once, as a preview the final words replace.
  if (state.words.trim() !== '') effects.push({ type: 'showWords', text: state.words });
  effects.push({ type: 'beginTurnWords', attempt });
  if (!zero) effects.push({ type: 'startCountdown', ms: state.graceMs });
  return step(
    {
      ...state,
      phase: 'sending',
      attempt,
      speechEndedAtMs,
      endReason: reason,
      endedAtMs: atMs,
      shown: state.words.trim() !== '',
      countdown: zero ? null : { startedAtMs: atMs, durationMs: state.graceMs },
      countdownElapsed: zero,
      wordsReady: false,
      wordsReadyAtMs: null,
      sendWhenReady: reason === 'user',
      sendNow: reason === 'user',
      sendInFlight: false,
    },
    effects,
  );
}

function sentTurn(state: LiveState, atMs: number): LiveStep {
  const endedAtMs = state.endedAtMs ?? atMs;
  const numbers: TurnNumbers = {
    turn: state.turn + 1,
    endReason: state.endReason ?? 'pause',
    endToWordsMs: Math.max(0, (state.wordsReadyAtMs ?? endedAtMs) - endedAtMs),
    graceMs: state.graceMs,
    endToSendMs: Math.max(0, atMs - endedAtMs),
    lastWordToSentMs: Math.max(0, atMs - (state.speechEndedAtMs ?? endedAtMs)),
    resumed: state.resumed,
    sendNow: state.sendNow,
  };
  return step(
    {
      ...state,
      ...FRESH_TURN,
      phase: 'working',
      turn: state.turn + 1,
      sentAtMs: atMs,
      holdReason: null,
      pauseReason: null,
      notice: null,
    },
    [{ type: 'recordTurn', numbers }, { type: 'watchReply' }],
  );
}

/** Mic open again from a hold, a pause or a finished reply. */
const reopen = (state: LiveState): LiveStep =>
  step(
    {
      ...state,
      ...FRESH_TURN,
      words: '',
      phase: 'starting',
      micReady: false,
      lockReady: true,
      holdReason: null,
      pauseReason: null,
      notice: null,
    },
    [{ type: 'openMic' }],
  );

/**
 * A turn is over (read, or not readable): listen again. Live reopens the microphone itself — and on a device that
 * cannot do that without a tap (`tapToListen`) waits On hold for "Listen" instead.
 */
function listenAgain(state: LiveState, notice: LiveNotice | null): LiveStep {
  const base = { ...state, ...FRESH_TURN, readKind: null, micReady: false, notice };
  if (state.tapToListen)
    return step({ ...base, phase: 'hold', holdReason: 'listen', pauseReason: null }, [{ type: 'closeMic' }]);
  return step({ ...base, phase: 'starting', lockReady: true, autoReopen: true, holdReason: null }, [
    { type: 'openMic' },
  ]);
}

/** Speak what the turn left: a new reading with a new id. */
function beginReading(state: LiveState, what: ReadWhat, before: readonly LiveEffect[]): LiveStep {
  const id = state.readId + 1;
  return step({ ...state, ...FRESH_TURN, phase: 'reading', readKind: what, readId: id }, [
    ...before,
    { type: 'speak', what, id },
  ]);
}

/** The reading is over (ended, failed or stopped): a question lands on its prompt, a reply back on listening. */
function finishReading(state: LiveState, end: ReadEnd, before: readonly LiveEffect[]): LiveStep {
  if (state.readKind === 'question')
    return step(
      { ...state, ...FRESH_TURN, phase: 'hold', holdReason: 'needs-input', readKind: null, notice: null },
      before,
    );
  const notice: LiveNotice | null =
    end === 'failed' || end === 'unavailable' ? { kind: 'read-failed', why: end } : null;
  const listening = listenAgain(state, notice);
  return step(listening.state, [...before, ...listening.effects]);
}

/** `starting` becomes `listening` only when the microphone is open AND the lock is ours. */
function startedOrWaiting(state: LiveState): LiveStep {
  if (!(state.micReady && state.lockReady)) return step(state);
  // A reply that could not be read says so on the first line of listening; anything else is cleared.
  const notice = state.notice?.kind === 'read-failed' ? state.notice : null;
  return state.hidden ? stepToPaused(state) : step(toListening(state, { notice }), [idleTimer]);
}

export function liveReduce(state: LiveState, event: LiveEvent): LiveStep {
  const { phase } = state;

  // Events that mean the same in every phase.
  if (event.type === 'visibility') {
    const hidden = !event.visible;
    const seen = { ...state, hidden };
    if (!hidden) return step(seen);
    if (
      phase === 'starting' ||
      phase === 'listening' ||
      phase === 'hearing' ||
      (phase === 'sending' && !state.sendInFlight)
    )
      return phase === 'starting' ? stepToPaused(seen) : park(seen, { phase: 'paused', reason: 'hidden' });
    if (phase === 'reading')
      // A question stays a question: it lands on its prompt. A reply waits for the person to come back.
      return state.readKind === 'question'
        ? step({ ...seen, ...FRESH_TURN, phase: 'hold', holdReason: 'needs-input', readKind: null }, [
            { type: 'stopSpeaking' },
          ])
        : step({ ...seen, ...FRESH_TURN, phase: 'paused', pauseReason: 'hidden', readKind: null }, [
            { type: 'stopSpeaking' },
          ]);
    return step(seen);
  }
  // A refusal of the one-Live-tab lock ends Live in EVERY active phase: two tabs must never both capture and send.
  if (event.type === 'locks' && !event.granted)
    return phase === 'off' ? step(state) : toOff(state, { kind: 'blocked', block: 'other-tab' });
  if (event.type === 'end') return phase === 'off' ? step(state) : toOff(state, null);
  if (event.type === 'reply' && event.signal === 'ended')
    return phase === 'off' ? step(state) : toOff(state, { kind: 'ended', why: 'ferret-stopped' });

  switch (phase) {
    case 'off': {
      if (event.type !== 'start') return step(state);
      if (!event.canSend) return step({ ...state, notice: { kind: 'blocked', block: 'no-send-rights' } });
      const base: LiveState = {
        ...INITIAL_LIVE_STATE,
        graceMs: resolveGraceMs(event.graceMs),
        canRead: event.canRead === true,
        tapToListen: event.tapToListen === true,
        hidden: !event.visible,
        turn: state.turn,
      };
      return step({ ...base, phase: 'starting', micReady: false, lockReady: false }, [
        { type: 'acquireLocks' },
        { type: 'openMic' },
      ]);
    }

    case 'starting': {
      // The microphone Live reopened by itself was refused (an iPhone wants a tap): wait for "Listen".
      if (event.type === 'blocked' && state.autoReopen)
        return step({ ...state, ...FRESH_TURN, phase: 'hold', holdReason: 'listen', micReady: false, readKind: null }, [
          { type: 'closeMic' },
        ]);
      if (event.type === 'blocked') return toOff(state, { kind: 'blocked', block: event.block });
      if (event.type === 'locks') return startedOrWaiting({ ...state, lockReady: true });
      if (event.type === 'listening') return startedOrWaiting({ ...state, micReady: true });
      return step(state);
    }

    case 'listening':
    case 'hearing':
      return reduceOpen(state, event);

    case 'sending':
      return reduceSending(state, event);

    case 'working': {
      if (event.type !== 'reply') return step(state);
      const stop: LiveEffect = { type: 'stopWatchReply' };
      // The ferret needs the person: read the question (and options) if this device can, then stop at the prompt.
      if (event.signal === 'needs-input')
        return state.canRead && !state.hidden
          ? beginReading(state, 'question', [stop])
          : step({ ...state, phase: 'hold', holdReason: 'needs-input', ...FRESH_TURN }, [stop]);
      if (event.signal !== 'done') return step(state);
      if (state.hidden) return step({ ...state, phase: 'paused', pauseReason: 'hidden' }, [stop]);
      if (state.canRead) return beginReading(state, 'reply', [stop]);
      const again = listenAgain(state, null);
      return step(again.state, [stop, ...again.effects]);
    }

    case 'reading': {
      switch (event.type) {
        case 'speak-done':
          return event.id === state.readId ? finishReading(state, event.end, []) : step(state);
        case 'skip':
          return finishReading(state, 'stopped', [{ type: 'stopSpeaking' }]);
        case 'repeat':
          return beginReading(state, state.readKind ?? 'reply', [{ type: 'stopSpeaking' }]);
        case 'outside-send':
          // A message sent by hand: this reading belongs to an older turn. Follow the new one.
          return step(
            { ...state, ...FRESH_TURN, phase: 'working', readKind: null, sentAtMs: event.atMs, turn: state.turn + 1 },
            [{ type: 'stopSpeaking' }, { type: 'watchReply' }],
          );
        default:
          return step(state);
      }
    }

    case 'hold': {
      if (event.type === 'resume') return reopen(state);
      if (event.type === 'send-now' && state.holdReason !== 'needs-input')
        return beginSend({
          ...state,
          phase: 'sending',
          sendNow: true,
          wordsReady: true,
          wordsReadyAtMs: event.atMs,
          endedAtMs: event.atMs,
          holdReason: null,
        });
      return step(state);
    }

    case 'paused': {
      if (event.type === 'resume' && !state.hidden)
        return step(
          {
            ...state,
            ...FRESH_TURN,
            words: '',
            phase: 'starting',
            micReady: false,
            lockReady: false,
            pauseReason: null,
          },
          [{ type: 'acquireLocks' }, { type: 'openMic' }],
        );
      return step(state);
    }
  }
}

/** A hidden tab before the microphone ever opened: nothing to close but the take that was being opened. */
function stepToPaused(state: LiveState): LiveStep {
  return step({ ...state, ...FRESH_TURN, words: '', phase: 'paused', pauseReason: 'hidden' }, [
    { type: 'cancelTimers' },
    { type: 'closeMic' },
  ]);
}

function reduceOpen(state: LiveState, event: LiveEvent): LiveStep {
  const hearing = state.phase === 'hearing';
  switch (event.type) {
    case 'speech-start':
      return hearing ? step(state) : step({ ...state, phase: 'hearing', notice: null }, [{ type: 'cancelTimers' }]);
    case 'speech-cancel':
      // A burst too short to be a turn. After a countdown was cancelled the earlier speech still stands.
      if (!hearing) return step(state);
      if (state.resumed && state.speechEndedAtMs !== null)
        return endTurn(state, event.atMs, state.speechEndedAtMs, state.endReason ?? 'pause');
      return step(toListening(state), [{ type: 'clearWords' }, idleTimer]);
    case 'live-words':
      return step({ ...state, words: event.text });
    case 'turn-end':
      return hearing ? endTurn(state, event.atMs, event.speechEndedAtMs, event.reason) : step(state);
    case 'send-now':
      return hearing ? endTurn(state, event.atMs, event.atMs, 'user') : step(state);
    case 'hold':
      return park(state, { phase: 'hold', reason: 'user' });
    case 'typing':
      return park(state, { phase: 'hold', reason: 'typing' });
    case 'blocked':
      return toOff(state, { kind: 'blocked', block: event.block });
    case 'timer':
      return event.kind === 'idle' && !hearing ? toOff(state, { kind: 'ended', why: 'idle' }) : step(state);
    default:
      return step(state);
  }
}

function reduceSending(state: LiveState, event: LiveEvent): LiveStep {
  if (state.sendInFlight) {
    if (event.type === 'sent') return sentTurn(state, event.atMs);
    if (event.type === 'send-failed')
      return step({
        ...state,
        phase: 'hold',
        holdReason: 'send-failed',
        sendInFlight: false,
        sendNow: false,
        countdown: null,
        countdownElapsed: false,
        park: null,
      });
    return step(state);
  }
  switch (event.type) {
    case 'turn-words':
      return event.attempt === state.attempt ? wordsArrived(state, event.atMs, event.text) : step(state);
    case 'turn-empty': {
      if (event.attempt !== state.attempt) return step(state);
      // A stop (Hold, typing, a hidden tab) asked for while the words were worked out stands: nothing came of
      // them, and the phase lands where the person put it — the microphone stays shut.
      if (state.park !== null) return step(landOn(state, state.park, '', false, null), stoppedWithoutWords);
      // Nothing was said that counts: quietly back to listening, the preview (if any) taken out again.
      return step(toListening(state), [
        { type: 'cancelCountdown' },
        { type: 'cancelTimers' },
        { type: 'clearWords' },
        { type: 'resumeListening' },
        idleTimer,
      ]);
    }
    case 'turn-failed': {
      if (event.attempt !== state.attempt) return step(state);
      const notice: LiveNotice = { kind: 'take-failed', block: event.block };
      if (state.park !== null) return step(landOn(state, state.park, '', false, notice), stoppedWithoutWords);
      return step(toListening(state, { notice: { kind: 'take-failed', block: event.block } }), [
        { type: 'cancelCountdown' },
        { type: 'cancelTimers' },
        { type: 'clearWords' },
        { type: 'resumeListening' },
        idleTimer,
      ]);
    }
    case 'countdown-done': {
      if (state.countdown === null) return step(state);
      const elapsed = { ...state, countdown: null, countdownElapsed: true };
      if (!state.wordsReady || state.park !== null) return step(elapsed);
      const remaining = Math.max(0, (state.wordsReadyAtMs ?? event.atMs) + SETTLE_MS - event.atMs);
      return remaining === 0
        ? beginSend(elapsed)
        : step(elapsed, [{ type: 'startTimer', kind: 'settle', ms: remaining }]);
    }
    case 'timer':
      return event.kind === 'settle' && state.wordsReady && state.park === null ? beginSend(state) : step(state);
    case 'speech-start':
      // A stop stands against renewed speech: nothing the room says reopens a parked turn.
      if (state.park !== null) return step(state);
      // The voice came back: the ring and everything the early finish produced are void.
      return step(
        {
          ...state,
          phase: 'hearing',
          attempt: state.attempt + 1,
          countdown: null,
          countdownElapsed: false,
          wordsReady: false,
          wordsReadyAtMs: null,
          sendWhenReady: false,
          sendNow: false,
          resumed: true,
          park: null,
        },
        [{ type: 'cancelCountdown' }, { type: 'cancelTimers' }, { type: 'resumeListening' }],
      );
    case 'hold':
      return park(state, { phase: 'hold', reason: 'user' });
    case 'typing':
      return park(state, { phase: 'hold', reason: 'typing' });
    case 'send-now': {
      if (state.park !== null) return step(state);
      if (state.wordsReady) return beginSend({ ...state, sendNow: true });
      return step({ ...state, sendWhenReady: true, sendNow: true });
    }
    case 'blocked':
      return toOff(state, { kind: 'blocked', block: event.block });
    default:
      return step(state);
  }
}

/** Whether the microphone is (meant to be) open in this phase: the UI's "mic" light. */
export const micIsOpen = (state: LiveState): boolean =>
  MIC_OPEN_PHASES.includes(state.phase) || (state.phase === 'sending' && !state.sendInFlight && state.park === null);
