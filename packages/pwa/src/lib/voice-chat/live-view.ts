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
  'engine-not-chosen': 'Choose how to dictate first in Settings › Voice, then press Live.',
  'engine-missing': 'This speech engine is not installed yet. Install it in Settings › Voice, then press Live.',
  'engine-failed': 'The speech engine stopped. Press Live to try again.',
  'no-send-rights': 'This device cannot send messages, so Live is off.',
  'other-tab': 'Live is on in another tab.',
  'ios-browser-voice':
    'On an iPhone Home Screen app, Live needs a voice that runs on this device. Choose one in Settings › Voice.',
});

export const LIVE_TAKE_FAILED_COPY = 'Speech service unreachable. Your words were kept.';

/** The line a notice puts under the state. */
export function noticeCopy(notice: LiveNotice): string {
  switch (notice.kind) {
    case 'blocked':
      return LIVE_BLOCK_COPY[notice.block];
    case 'take-failed':
      return LIVE_TAKE_FAILED_COPY;
    case 'ended':
      return notice.why === 'idle' ? 'Live ended after ten minutes of quiet.' : 'Ferret stopped. Live ended.';
  }
}

export type LiveTone = 'calm' | 'active' | 'warn' | 'error';

/** What a tap on the big (phone) button does. */
export type LiveBigAction = 'hold' | 'resume' | 'skip' | 'none';

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
  user: 'Your words are in the composer. Resume, or send them.',
  typing: 'Paused while you type. Resume when you are ready.',
  'send-failed': "Couldn't send. Your words are in the composer.",
  'needs-input': 'Ferret needs your answer.',
} as const;

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
      return { ...base, stateWord: 'Starting…', big: { label: 'Starting', action: 'none' } };
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
        big: { label: 'Hold', action: 'hold' },
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
    case 'reading':
      return { ...base, stateWord: 'Reading reply', tone: 'active', big: { label: 'Stop reading', action: 'skip' } };
    case 'hold': {
      const reason = state.holdReason ?? 'user';
      return {
        ...base,
        stateWord: 'On hold',
        detail: HOLD_COPY[reason],
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
        detail: 'Live paused while away. Resume?',
        tone: 'warn',
        big: { label: 'Resume Live', action: 'resume' },
        canResume: !state.hidden,
      };
  }
}

/** The key a press maps to, or null. Only the bar's own keys; the caller checks the focus is not in a text field. */
export type LiveKeyAction = 'hold' | 'send-now' | 'resume' | 'skip' | 'end';

export function liveKeyAction(key: string, view: LiveView): LiveKeyAction | null {
  if (!view.visible || view.phase === 'off') return null;
  switch (key) {
    case 'Escape':
      return view.canEnd ? 'end' : null;
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
