/**
 * WHAT THE LIVE BAR SAYS, as plain data: the state in words, the ring, the buttons, the line under
 * them. The bar (`components/live-voice-bar.tsx`) draws this and nothing else, so every rule about
 * wording and about which control is offered when is tested here without a DOM.
 *
 * The state is ALWAYS said in words (colour is never the only signal), the countdown is also a number
 * (the ring is decoration; reduced motion shows the number alone), and the words people need after a
 * refusal say what to do next. See docs/voice.md › Live voice.
 */

import { type LiveNotice, type LivePhase, type LiveState, micIsOpen, type TurnNumbers } from './live-machine.ts';
import { lastTurnCopy } from './live-turn-log.ts';
import type { LiveBlock } from './ports.ts';

/** The words for every reason Live cannot start or stops. */
export const LIVE_BLOCK_COPY: Readonly<Record<LiveBlock, string>> = Object.freeze({
  'mic-blocked': 'Microphone is blocked for this site. Allow it, then press Live.',
  'engine-not-chosen': 'Pick a voice in Settings › Voice first, then press Live.',
  'engine-missing': "This voice isn't installed yet — install it in Settings › Voice, then press Live.",
  'engine-failed': 'The voice stopped. Press Live to try again.',
  'no-send-rights': 'This device cannot send messages, so Live is off.',
  'other-tab': 'Live is on in another tab.',
  'ios-browser-voice':
    'On an iPhone Home Screen app, Live needs a voice that runs on this device. Choose one in Settings › Voice.',
});

export const READ_FAILED_COPY = "Couldn't speak this reply. It is on screen.";
export const READ_UNAVAILABLE_COPY = 'This device has no built-in voice for reading, so the reply stays on screen.';

const VOICE_SERVICE_COPY = "Can't reach the voice service.";
export const LIVE_TAKE_FAILED_COPY = `${VOICE_SERVICE_COPY} Your words were kept.`;

/** The line a notice puts under the state. */
export function noticeCopy(notice: LiveNotice): string {
  switch (notice.kind) {
    case 'blocked':
      return LIVE_BLOCK_COPY[notice.block];
    case 'take-failed':
      return LIVE_TAKE_FAILED_COPY;
    case 'read-failed':
      return notice.why === 'unavailable' ? READ_UNAVAILABLE_COPY : READ_FAILED_COPY;
    case 'ended':
      return notice.why === 'idle' ? 'Live ended after ten minutes of quiet.' : 'Ferret stopped. Live ended.';
  }
}

type LiveTone = 'calm' | 'active' | 'warn' | 'error';

/** What a tap on the big (phone) button does. */
type LiveBigAction = 'hold' | 'resume' | 'skip' | 'none';

export interface LiveView {
  /** The bar is on screen: Live is on, or says why it is not. */
  readonly visible: boolean;
  readonly phase: LivePhase;
  /** The state, always in words: "Listening", "Sending in 2 s". */
  readonly stateWord: string;
  /** A second line: what the person needs to know or do. */
  readonly detail: string | null;
  readonly tone: LiveTone;
  /** The ring: 0 → 1 as the countdown fills, and the whole seconds left. Null when none is running. */
  readonly ring: { readonly progress: number; readonly secondsLeft: number } | null;
  /** The label and action of the 96 px button. */
  readonly big: { readonly label: string; readonly action: LiveBigAction };
  readonly canHold: boolean;
  readonly canSendNow: boolean;
  readonly canResume: boolean;
  /** A reply is being read: Stop (Space, Esc, S) ends it and Live listens again. */
  readonly canSkip: boolean;
  /** A reply is being read: Repeat (R) reads it again from the start. */
  readonly canRepeat: boolean;
  /** "End" is offered whenever Live is on. */
  readonly canEnd: boolean;
  readonly micOpen: boolean;
  /** Words heard so far, while the engine reports them. */
  readonly liveWords: string;
  /** Whole seconds since the message was sent, in Working. */
  readonly workingSeconds: number | null;
}

const mmss = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const HOLD_COPY = {
  user: 'Your words are in the message box. Resume, or send them.',
  typing: 'Paused while you type. Resume when you are ready.',
  'send-failed': "Couldn't send. Your words are in the message box.",
  'needs-input': 'Your ferret is asking you something.',
  listen: 'The reply has been read. Tap Listen to talk.',
  speaking: 'Another message is being read aloud. Listen stops it and talks.',
} as const;

/** The line under a hold or a pause; a take that failed while the stop waited for its words says so first. */
const heldDetail = (state: LiveState, line: string): string =>
  state.notice?.kind === 'take-failed' ? `${VOICE_SERVICE_COPY} ${line}` : line;

const OFF_VIEW: LiveView = {
  visible: false,
  phase: 'off',
  stateWord: 'Live is off',
  detail: null,
  tone: 'calm',
  ring: null,
  big: { label: 'Live', action: 'none' },
  canHold: false,
  canSendNow: false,
  canResume: false,
  canSkip: false,
  canRepeat: false,
  canEnd: false,
  micOpen: false,
  liveWords: '',
  workingSeconds: null,
};

/**
 * The bar for `state` at `nowMs` (the machine's clock). `composerHasWords`: the box holds something to send.
 * `lastTurn`: the numbers of the message just sent, said under Working.
 */
export function liveView(
  state: LiveState,
  nowMs: number,
  composerHasWords = false,
  lastTurn: TurnNumbers | null = null,
): LiveView {
  const base: LiveView = {
    ...OFF_VIEW,
    visible: true,
    phase: state.phase,
    canEnd: true,
    micOpen: micIsOpen(state),
    liveWords: state.phase === 'hearing' ? state.words : '',
  };
  switch (state.phase) {
    case 'off':
      return state.notice === null
        ? OFF_VIEW
        : { ...OFF_VIEW, visible: true, detail: noticeCopy(state.notice), tone: 'warn', stateWord: 'Live is off' };
    case 'starting':
      return {
        ...base,
        stateWord: 'Starting…',
        // Only the very first start can be waiting on the browser's permission question.
        detail: !state.micReady && state.turn === 0 ? 'Allow the microphone if your browser asks.' : null,
        big: { label: 'Starting', action: 'none' },
      };
    case 'listening':
      return {
        ...base,
        stateWord: 'Listening',
        detail: state.notice === null ? null : noticeCopy(state.notice),
        tone: state.notice === null ? 'calm' : 'warn',
        big: { label: 'Listening', action: 'hold' },
        canHold: true,
      };
    case 'hearing':
      return {
        ...base,
        stateWord: 'Hearing you',
        tone: 'active',
        big: { label: 'Hearing you', action: 'hold' },
        canHold: true,
        canSendNow: true,
      };
    case 'sending': {
      if (state.sendInFlight)
        return { ...base, stateWord: 'Sending…', tone: 'active', big: { label: 'Sending', action: 'none' } };
      const countdown = state.countdown;
      const left = countdown === null ? 0 : Math.max(0, countdown.startedAtMs + countdown.durationMs - nowMs);
      const secondsLeft = Math.ceil(left / 1_000);
      const parked = state.park !== null;
      const ring =
        countdown === null || parked
          ? null
          : { progress: Math.min(1, Math.max(0, 1 - left / countdown.durationMs)), secondsLeft };
      // The ring is done (or there never was one) but the words are not here yet.
      const waiting = parked || (!state.wordsReady && secondsLeft === 0);
      return {
        ...base,
        stateWord: waiting ? 'Getting your words…' : secondsLeft > 0 ? `Sending in ${secondsLeft} s` : 'Sending…',
        tone: 'active',
        ring,
        // A stop that is waiting for the words is already in force: nothing to press until they land.
        big: parked ? { label: 'One moment', action: 'none' } : { label: 'Hold', action: 'hold' },
        canHold: !parked,
        canSendNow: !parked,
      };
    }
    case 'working': {
      const seconds = state.sentAtMs === null ? 0 : Math.max(0, Math.floor((nowMs - state.sentAtMs) / 1_000));
      return {
        ...base,
        stateWord: `Working ${mmss(seconds)}`,
        detail: lastTurn === null ? null : lastTurnCopy(lastTurn),
        tone: 'calm',
        workingSeconds: seconds,
        big: { label: `Working ${mmss(seconds)}`, action: 'none' },
      };
    }
    case 'reading': {
      const question = state.readKind === 'question';
      return {
        ...base,
        // The words of the reply are never here: they are on screen, and the live region must not say them twice.
        stateWord: question ? 'Reading question' : 'Reading reply',
        detail: question ? 'Your ferret is asking you something.' : null,
        tone: 'active',
        big: { label: 'Stop reading', action: 'skip' },
        canSkip: true,
        canRepeat: true,
      };
    }
    case 'hold': {
      const reason = state.holdReason ?? 'user';
      // The reply was read and the microphone waits for a tap: it is the person's turn, not a hold they asked for.
      if (reason === 'listen' || reason === 'speaking')
        return {
          ...base,
          stateWord: reason === 'speaking' ? 'On hold' : 'Your turn',
          detail: heldDetail(state, HOLD_COPY[reason]),
          tone: 'calm',
          big: { label: 'Listen', action: 'resume' },
          canResume: true,
          canSendNow: composerHasWords || state.words.trim() !== '',
        };
      return {
        ...base,
        stateWord: 'On hold',
        detail: heldDetail(state, HOLD_COPY[reason]),
        tone: reason === 'send-failed' ? 'error' : 'warn',
        big: { label: 'Resume', action: 'resume' },
        canResume: true,
        canSendNow: reason !== 'needs-input' && (composerHasWords || state.words.trim() !== ''),
      };
    }
    case 'paused':
      return {
        ...base,
        stateWord: 'Paused',
        detail: heldDetail(state, 'Live paused while away. Resume?'),
        tone: 'warn',
        big: { label: 'Resume Live', action: 'resume' },
        canResume: !state.hidden,
      };
  }
}

/** The key a press maps to, or null. Only the bar's own keys; the caller checks the focus is not in a text field. */
export type LiveKeyAction = 'hold' | 'send-now' | 'resume' | 'skip' | 'repeat' | 'end';

export function liveKeyAction(key: string, view: LiveView): LiveKeyAction | null {
  if (!view.visible || view.phase === 'off') return null;
  switch (key) {
    case 'Escape':
      // While a reply is being read Esc stops the reading (back to listening); otherwise it ends Live.
      if (view.canSkip) return 'skip';
      return view.canEnd ? 'end' : null;
    case 's':
    case 'S':
      return view.canSkip ? 'skip' : null;
    case 'r':
    case 'R':
      return view.canRepeat ? 'repeat' : null;
    case 'Enter':
      return view.canSendNow ? 'send-now' : null;
    case 'h':
    case 'H':
      return view.canHold ? 'hold' : null;
    case ' ':
    case 'Spacebar':
      if (view.canResume) return 'resume';
      return view.big.action === 'skip' ? 'skip' : null;
    default:
      return null;
  }
}
