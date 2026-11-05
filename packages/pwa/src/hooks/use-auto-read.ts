/**
 * AUTO-READ REPLIES — the composition point (three-layer architecture): it joins the pure turn watcher
 * (`lib/voice-chat/auto-read.ts`), the pure reply picker (`reply-picker.ts`), this device's voice settings
 * and slice 1's read-aloud controller, and owns the only two things that need a browser: a timer and a few
 * document events.
 *
 * WHAT IT DOES
 *
 *   - With "Auto-read replies" ON, a turn that ends while this page is open is read aloud: the last message
 *     of the turn (or every message, if chosen), "Done. No message." for a silent turn, or the question and
 *     its options when the ferret needs an answer — which is only ever READ, never answered by voice.
 *   - With it OFF (the default) it does nothing at all: it does not even watch.
 *
 * WHAT STOPS A READING
 *
 *   - A new message from this page (the page's send signal), a key press, or a tap anywhere. The mic is
 *     never open for this, so interrupting is by hand only. Only a reading this hook started is stopped by
 *     a tap or key: pressing Read aloud on a message yourself is not undone by the tap that started it.
 *   - The tab going to the background. A turn that ends while the tab is hidden is NOT read on return: it
 *     stays silent rather than speak at someone who has walked away. The completion is judged when it is
 *     SEEN (and again the moment the tab hides), not when a timer later fires, so coming back before the
 *     timer would have fired changes nothing.
 *   - Leaving the conversation, or switching the setting off.
 *
 * A SEND IS A TOKEN, TAKEN WHEN THE PRESS HAPPENS, AND BOUND TO THE SEND'S OWN IDENTITY. The page calls
 * `beginSend` as the composer starts sending, before anything is awaited: that stops a reading under way,
 * drops whatever was pending for an earlier send, remembers the newest turn state and the rows the page
 * already held, and arms the watch. `sent(sendId)` binds the token to the send the request came back with;
 * the daemon's ledger entry for that id says when the daemon accepted it, and only a turn that began after
 * that moment — never "now", a browser clock, or a state merely newer than an old snapshot — is its reply.
 * The press reads nothing by itself, and the send's acknowledgement only stops a reading when no press
 * announced it: otherwise it would cut off the fast reply it belongs to. A send whose request failed drops
 * its token (`failed`).
 *
 * ONLY A DAEMON THAT DATES ITS TURNS IS WATCHED. With no `turnStateAt` nothing is armed and nothing is read:
 * there is no guess to fall back on, and Read aloud on a message still works.
 *
 * One reading at a time is the controller's own guarantee: starting this one replaces any other.
 * Nothing here logs, stores or sends the words it hands the controller.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  armOnSend,
  dropSend,
  IDLE_WATCH,
  observeTurn,
  stopWatching,
  type TurnWatch,
  type WatchedTurn,
} from '../lib/voice-chat/auto-read.ts';
import { readOptionsOf } from '../lib/voice-chat/live-settings.ts';
import { IDLE } from '../lib/voice-chat/read-aloud.ts';
import {
  hasRowSince,
  type PickerRow,
  pickQuestion,
  pickReply,
  type QuestionLike,
} from '../lib/voice-chat/reply-picker.ts';
import { useDocumentVisible } from './use-document-visible.ts';
import { useDeviceVoiceSettingsStore, useLiveVoiceSettings } from './use-live-voice-settings.ts';
import { useReadAloudController } from './use-read-aloud.ts';

/** What the page knows of a send's acceptance: the id it went under, and when the DAEMON accepted it (its clock). */
export interface SendAcceptance {
  readonly sendId: string;
  readonly acceptedAt: string;
}

export interface AutoReadInput {
  /** `daemon/session`: a new scope is a new conversation, so nothing carries over. */
  readonly scope: string;
  readonly entries: readonly PickerRow[];
  /** Whose turn it is (`state.turnState`), or null for a session that is not live — and for a daemon that sends none. */
  readonly turn: WatchedTurn | null;
  /** The daemon's `state.turnStateAt`. Absent (or unreadable): the daemon cannot date its turns and nothing is auto-read. */
  readonly turnStateAt: string | undefined;
  /** The question a `needs-input` turn waits on. */
  readonly question: QuestionLike | null | undefined;
  /** The daemon's own send ledger for this session (not the browser's outbox): where `acceptedAt` comes from. */
  readonly sends: readonly SendAcceptance[];
  /** The clock, for tests. */
  readonly now?: () => number;
}

export interface AutoReadHandle {
  /** A reading this hook started is going on right now. */
  readonly reading: boolean;
  readonly stop: () => void;
  /** The person pressed send (call it as the send starts, before awaiting it): the next turn that send starts is the one to read. */
  readonly beginSend: () => void;
  /** The send's request came back under this id (absent when it has none): the reply is judged against the daemon's record of it. */
  readonly sent: (sendId: string | undefined) => void;
  /** The send's request failed: nothing is waited on. */
  readonly failed: () => void;
}

/** The rows the page held when a send began, and the id it went under once the request came back. */
interface SendToken {
  readonly knownIds: readonly string[];
  readonly sendId: string | null;
}

const parseInstant = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

export function useAutoRead(input: AutoReadInput): AutoReadHandle {
  const { scope, entries, turn, turnStateAt, sends, now = Date.now } = input;
  const controller = useReadAloudController();
  const store = useDeviceVoiceSettingsStore();
  const { settings } = useLiveVoiceSettings(store);
  const visible = useDocumentVisible();

  // Everything the evaluation reads, in one ref, so a timer always sees the latest without re-arming.
  const latest = useRef({ ...input, settings, visible });
  latest.current = { ...input, settings, visible };
  const watch = useRef<TurnWatch>(IDLE_WATCH);
  const token = useRef<SendToken | null>(null);
  const changedAt = useRef(now());
  const seen = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The key of the reading this hook started, or null. */
  const mine = useRef<string | null>(null);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, () => IDLE);
  const reading = mine.current !== null && state.status === 'reading' && state.key === mine.current;

  const stop = useCallback(() => {
    if (mine.current !== null && controller.getState().key === mine.current) controller.stop();
    mine.current = null;
  }, [controller]);

  const evaluate = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const current = latest.current;
    const fired = { knownIds: token.current?.knownIds, sendId: token.current?.sendId ?? null };
    if (!current.settings.autoRead || !controller.supported) {
      // Off: nothing is watched, but what was already read stays read.
      watch.current = stopWatching(watch.current);
      token.current = null;
      return;
    }
    const at = now();
    const accepted = current.sends.find(send => send.sendId === fired.sendId);
    const step = observeTurn(watch.current, {
      turn: current.turn,
      turnAt: parseInstant(current.turnStateAt),
      quietMs: at - changedAt.current,
      visible: current.visible,
      boundary: accepted === undefined ? null : parseInstant(accepted.acceptedAt),
      sentRow: fired.knownIds !== undefined && hasRowSince(current.entries, fired.knownIds),
    });
    watch.current = step.watch;
    if (step.watch.armed?.kind !== 'sent') token.current = null;
    if (step.fire !== null) {
      const pick =
        step.fire.outcome === 'needs-input'
          ? pickQuestion(current.question)
          : pickReply(
              current.entries,
              { startedAt: step.fire.startedAt, knownIds: fired.knownIds },
              current.settings.whatToRead,
            );
      mine.current = pick.key;
      controller.read(pick.key, pick.markdown, readOptionsOf(current.settings));
      return;
    }
    if (step.recheckInMs !== null) timer.current = setTimeout(evaluate, step.recheckInMs);
  }, [controller, now]);

  // A different conversation starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is the trigger.
  useEffect(() => {
    watch.current = IDLE_WATCH;
    token.current = null;
    mine.current = null;
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [scope]);

  // The conversation changed (a record, a new turn state, the daemon's word on a send): note the moment and look again.
  const last = entries.at(-1);
  const acceptance = sends.find(send => send.sendId === token.current?.sendId)?.acceptedAt ?? '';
  const changeKey = `${scope}|${entries.length}|${last?.id ?? ''}|${last?.text.length ?? 0}|${turn ?? ''}|${turnStateAt ?? ''}|${acceptance}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the change key is what says the conversation moved; the rest is read through `latest`.
  useEffect(() => {
    if (seen.current !== changeKey) {
      seen.current = changeKey;
      changedAt.current = now();
    }
    evaluate();
  }, [changeKey, settings.autoRead, evaluate, now]);

  /** Arms a send from what the page has seen up to this moment — or arms nothing when this daemon dates no turns. */
  const arm = useCallback(
    (sendId: string | null): void => {
      const current = latest.current;
      if (!current.settings.autoRead || !controller.supported || parseInstant(current.turnStateAt) === null) {
        token.current = null;
        return;
      }
      token.current = { knownIds: current.entries.map(row => row.id), sendId };
      watch.current = armOnSend(watch.current);
      // Quiet counts from the press, not from whenever the conversation last changed before it.
      changedAt.current = now();
    },
    [controller, now],
  );

  // THE PRESS: the composer starts a send. Arm now, from what the page has seen up to this moment.
  const beginSend = useCallback(() => {
    stop();
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    arm(null);
    evaluate();
  }, [arm, evaluate, stop]);

  // The send came back. A press that was announced is bound to its id and stops nothing: a fast reply to it may
  // already be being read. A send nobody announced (answering a form, a held message sent later) stops what is
  // being read and, when it has an id, is armed now.
  const sent = useCallback(
    (sendId: string | undefined) => {
      const waiting = token.current;
      if (waiting !== null && waiting.sendId === null) {
        if (sendId === undefined) {
          // No id, nothing to correlate the reply with: the press is dropped.
          token.current = null;
          watch.current = dropSend(watch.current);
        } else {
          token.current = { ...waiting, sendId };
        }
        evaluate();
        return;
      }
      stop();
      if (sendId !== undefined) arm(sendId);
      evaluate();
    },
    [arm, evaluate, stop],
  );

  // The send's request failed: the press is let go.
  const failed = useCallback(() => {
    if (token.current?.sendId === null) {
      token.current = null;
      watch.current = dropSend(watch.current);
    }
    evaluate();
  }, [evaluate]);

  // Switched off: silence what this hook started.
  useEffect(() => {
    if (!settings.autoRead) stop();
  }, [settings.autoRead, stop]);

  // The tab goes to the background: speech stops, the timer is cancelled and anything that has ended is
  // judged now, while nobody is looking — so it can never be read on return.
  useEffect(() => {
    if (visible) return;
    controller.stop();
    evaluate();
  }, [visible, controller, evaluate]);

  // A tap or a key stops a reading this hook started.
  useEffect(() => {
    if (!reading) return;
    const interrupt = (): void => stop();
    document.addEventListener('keydown', interrupt, true);
    document.addEventListener('pointerdown', interrupt, true);
    return () => {
      document.removeEventListener('keydown', interrupt, true);
      document.removeEventListener('pointerdown', interrupt, true);
    };
  }, [reading, stop]);

  return { reading, stop, beginSend, sent, failed };
}
