/**
 * Which ferrets this page is in voice mode with, and the one sentence left behind when a voice mode ended on its own.
 *
 * Voice mode is drawn in two places that cannot see each other: the Voice button in the composer's tools (which starts it)
 * and the panel that stands in front of the composer (which runs it). This store is the one fact they share, held per page
 * by `voiceSurfaces`. It holds no audio, no words and no secret: only "on or off", the machine's name, and a sentence.
 */
import { useSyncExternalStore } from 'react';

export interface VoiceModeState {
  readonly active: boolean;
  /** The machine the voice goes to (named in the panel); empty while off. */
  readonly machine: string;
  /** Why voice mode is not running, when it stopped by itself or could not start. Cleared by Dismiss or the next start. */
  readonly notice: string | null;
}

const OFF: VoiceModeState = { active: false, machine: '', notice: null };

export interface VoiceModeStore {
  get(ferretId: string): VoiceModeState;
  start(ferretId: string, machine: string): void;
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
    start: (ferretId, machine) => set(ferretId, { active: true, machine, notice: null }),
    end: (ferretId, notice) => {
      const current = states.get(ferretId);
      if (current === undefined && notice === undefined) return;
      if (current !== undefined && !current.active && notice === undefined) return;
      set(ferretId, notice === undefined ? OFF : { active: false, machine: current?.machine ?? '', notice });
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
