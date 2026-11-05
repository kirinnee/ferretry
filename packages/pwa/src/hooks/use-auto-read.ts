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
 *     stays silent rather than speak at someone who has walked away.
 *   - Leaving the conversation, or switching the setting off.
 *
 * One reading at a time is the controller's own guarantee: starting this one replaces any other.
 * Nothing here logs, stores or sends the words it hands the controller.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { armOnSend, IDLE_WATCH, observeTurn, type TurnWatch, type WatchedTurn } from '../lib/voice-chat/auto-read.ts';
import { readOptionsOf } from '../lib/voice-chat/live-settings.ts';
import { IDLE } from '../lib/voice-chat/read-aloud.ts';
import { type PickerRow, pickQuestion, pickReply, type QuestionLike } from '../lib/voice-chat/reply-picker.ts';
import { useDocumentVisible } from './use-document-visible.ts';
import { useDeviceVoiceSettingsStore, useLiveVoiceSettings } from './use-live-voice-settings.ts';
import { useReadAloudController } from './use-read-aloud.ts';

export interface AutoReadInput {
  /** `daemon/session`: a new scope is a new conversation, so nothing carries over. */
  readonly scope: string;
  readonly entries: readonly PickerRow[];
  /** Whose turn it is (`sessionTurn`), or null for a session that is not live. */
  readonly turn: WatchedTurn | null;
  /** The daemon's `state.turnStateAt`, when it sent one. */
  readonly turnStateAt: string | undefined;
  /** The daemon sent no `turnState`: `turn` is the page's own guess. */
  readonly legacy: boolean;
  /** The question a `needs-input` turn waits on. */
  readonly question: QuestionLike | null | undefined;
  /** Bumped by the page each time the person sends: the next end of turn is the reply to it. */
  readonly sendSignal: number;
  /** The clock, for tests. */
  readonly now?: () => number;
}

export interface AutoReadHandle {
  /** A reading this hook started is going on right now. */
  readonly reading: boolean;
  readonly stop: () => void;
}

const parseInstant = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

export function useAutoRead(input: AutoReadInput): AutoReadHandle {
  const { scope, entries, turn, turnStateAt, sendSignal, now = Date.now } = input;
  const controller = useReadAloudController();
  const store = useDeviceVoiceSettingsStore();
  const { settings } = useLiveVoiceSettings(store);
  const visible = useDocumentVisible();

  // Everything the evaluation reads, in one ref, so a timer always sees the latest without re-arming.
  const latest = useRef({ ...input, settings, visible });
  latest.current = { ...input, settings, visible };
  const watch = useRef<TurnWatch>(IDLE_WATCH);
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
    if (!current.settings.autoRead || !controller.supported) {
      watch.current = IDLE_WATCH;
      return;
    }
    const at = now();
    const step = observeTurn(watch.current, {
      now: at,
      turn: current.turn,
      turnAt: parseInstant(current.turnStateAt),
      legacy: current.legacy,
      quietMs: at - changedAt.current,
    });
    watch.current = step.watch;
    if (step.fire !== null) {
      // A turn that ended while nobody was looking is not read at them on return.
      if (!current.visible) return;
      const pick =
        step.fire.outcome === 'needs-input'
          ? pickQuestion(current.question)
          : pickReply(current.entries, step.fire.startedAt, current.settings.whatToRead);
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
    mine.current = null;
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [scope]);

  // The conversation changed (a record, a new turn state): note the moment and look again.
  const last = entries.at(-1);
  const changeKey = `${scope}|${entries.length}|${last?.id ?? ''}|${last?.text.length ?? 0}|${turn ?? ''}|${turnStateAt ?? ''}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the change key is what says the conversation moved; the rest is read through `latest`.
  useEffect(() => {
    if (seen.current !== changeKey) {
      seen.current = changeKey;
      changedAt.current = now();
    }
    evaluate();
  }, [changeKey, settings.autoRead, evaluate, now]);

  // The person sent something: stop what is being read, and the next end of turn is its reply.
  const firstSend = useRef(sendSignal);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the send signal is the trigger.
  useEffect(() => {
    if (sendSignal === firstSend.current) return;
    firstSend.current = sendSignal;
    stop();
    if (latest.current.settings.autoRead) watch.current = armOnSend(watch.current, now());
  }, [sendSignal]);

  // Switched off: silence what this hook started.
  useEffect(() => {
    if (!settings.autoRead) stop();
  }, [settings.autoRead, stop]);

  // The tab goes to the background: speech stops.
  useEffect(() => {
    if (!visible) controller.stop();
  }, [visible, controller]);

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

  return { reading, stop };
}
