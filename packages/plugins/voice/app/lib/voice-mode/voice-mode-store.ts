/**
 * Which ferrets this page is in voice mode with, which engine each is on, and the one sentence left behind when a voice
 * mode ended on its own.
 *
 * Voice mode is drawn in two places that cannot see each other: the Voice button in the composer's tools (which starts it)
 * and the panel that stands in front of the composer (which runs it). This store is the one fact they share, held per page
 * by `voiceSurfaces`. It holds no audio, no words and no secret: only "on or off", which engine, the machine's name, and
 * sentences.
 *
 * TWO ENGINES. `machine` (the default) is the machine's speech over the voice stream. `phone` is this device's own
 * dictation engine and voice: it is only ever a fallback, and `banner` is the sentence that says why (the machine could not
 * be reached, was lost mid-chat, or the person asked for audio to stay on this phone). A phone engine without a banner
 * cannot exist, so the person is never on it without being told.
 */
import { useSyncExternalStore } from 'react';

type VoiceModeEngine = 'machine' | 'phone';

export interface VoiceModeState {
  readonly active: boolean;
  /** Which engine runs the loop while `active`. */
  readonly engine: VoiceModeEngine;
  /** The machine the voice goes to (named in the panel); empty while off. */
  readonly machine: string;
  /** Why the loop is on the phone, while it is: shown in the panel for as long as it is. `null` on the machine. */
  readonly banner: string | null;
  /** Why voice mode is not running, when it stopped by itself or could not start. Cleared by Dismiss or the next start. */
  readonly notice: string | null;
}

const OFF: VoiceModeState = { active: false, engine: 'machine', machine: '', banner: null, notice: null };

export interface VoiceModeStore {
  get(ferretId: string): VoiceModeState;
  /** Starts voice mode on the machine, or on the phone when `onPhone` says why. */
  start(ferretId: string, machine: string, onPhone?: string): void;
  /** The machine's loop was lost: the same panel carries on, on the phone, and `why` is said in it. */
  fallBack(ferretId: string, why: string): void;
  /** Ends voice mode for the ferret. `notice` is shown above the composer until it is dismissed. */
  end(ferretId: string, notice?: string): void;
  dismiss(ferretId: string): void;
  subscribe(listener: () => void): () => void;
}

export function createVoiceModeStore(): VoiceModeStore {
  let states: ReadonlyMap<string, VoiceModeState> = new Map();
  const listeners = new Set<() => void>();
  const set = (ferretId: string, next: VoiceModeState): void => {
    const copy = new Map(states);
    if (next === OFF) copy.delete(ferretId);
    else copy.set(ferretId, next);
    states = copy;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: ferretId => states.get(ferretId) ?? OFF,
    start: (ferretId, machine, onPhone) =>
      set(
        ferretId,
        onPhone === undefined
          ? { active: true, engine: 'machine', machine, banner: null, notice: null }
          : { active: true, engine: 'phone', machine, banner: onPhone, notice: null },
      ),
    fallBack: (ferretId, why) => {
      const current = states.get(ferretId);
      if (current === undefined || !current.active || current.engine === 'phone') return;
      set(ferretId, { ...current, engine: 'phone', banner: why });
    },
    end: (ferretId, notice) => {
      const current = states.get(ferretId);
      if (current === undefined && notice === undefined) return;
      if (current !== undefined && !current.active && notice === undefined) return;
      set(
        ferretId,
        notice === undefined
          ? OFF
          : { active: false, engine: 'machine', machine: current?.machine ?? '', banner: null, notice },
      );
    },
    dismiss: ferretId => {
      const current = states.get(ferretId);
      if (current === undefined || current.active) return;
      set(ferretId, OFF);
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** This ferret's voice mode, as it is now. */
export function useVoiceMode(store: VoiceModeStore, ferretId: string): VoiceModeState {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(ferretId),
    () => OFF,
  );
}
