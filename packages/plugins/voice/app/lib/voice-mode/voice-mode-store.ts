/**
 * Which ferrets this page is in voice mode with, which engine each is on, and the one sentence left behind when a voice
 * mode ended on its own.
 *
 * Voice mode is drawn in two places that cannot see each other: the Voice button in the composer's tools (which starts it)
 * and the panel that stands in front of the composer (which runs it). This store is the one fact they share, held per page
 * by `voiceSurfaces`. It holds no audio, no words and no secret: only "on or off", which engine, the machine's name,
 * sentences, and the sound output the button opened inside the tap (a browser lets sound start only from one, so the panel
 * that runs later takes it from here instead of making its own).
 *
 * TWO ENGINES. `machine` (the default) is the machine's speech over the voice stream. `phone` is this device's own
 * dictation engine and voice: it is only ever a fallback, and `banner` is the sentence that says why (the machine could not
 * be reached, was lost mid-chat, or the person asked for audio to stay on this phone). A phone engine without a banner
 * cannot exist, so the person is never on it without being told.
 */
import { useSyncExternalStore } from 'react';
import type { ReplyPlayer } from '../stream/voice-stream.ts';
import type { LiveSink } from './live-lines.ts';

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
  /** The sound output created inside the tap that started voice mode; the panel plays the machine's voice through it. */
  readonly player?: ReplyPlayer;
  /**
   * This voice-mode session's name, minted when it started and kept until it ends: a stream that drops and reopens inside it
   * says the same one, so the machine's entry message is not sent again. Empty while off.
   */
  readonly session: string;
}

const OFF: VoiceModeState = { active: false, engine: 'machine', machine: '', banner: null, notice: null, session: '' };

/** A fresh session name: URL-safe and inside the stream's limit for one. */
const newVoiceSession = (): string => `vm-${globalThis.crypto.randomUUID()}`;

export interface VoiceModeStore {
  get(ferretId: string): VoiceModeState;
  /** Starts voice mode on the machine, or on the phone when `onPhone` says why. `player` is the sound output made inside the tap. */
  start(ferretId: string, machine: string, onPhone?: string, player?: ReplyPlayer): void;
  /** The machine's loop was lost: the same panel carries on, on the phone, and `why` is said in it. */
  fallBack(ferretId: string, why: string): void;
  /** Ends voice mode for the ferret. `notice` is shown above the composer until it is dismissed. */
  end(ferretId: string, notice?: string): void;
  dismiss(ferretId: string): void;
  /** The panel's machine voice for live lines (`null` when it goes). Not part of what is drawn, so it never re-renders anything. */
  attachLive(ferretId: string, sink: LiveSink | null): void;
  /** The machine voice live lines go to, while the panel has one. */
  live(ferretId: string): LiveSink | undefined;
  subscribe(listener: () => void): () => void;
}

export function createVoiceModeStore(mint: () => string = newVoiceSession): VoiceModeStore {
  let states: ReadonlyMap<string, VoiceModeState> = new Map();
  const sinks = new Map<string, LiveSink>();
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
    start: (ferretId, machine, onPhone, player) =>
      set(ferretId, {
        active: true,
        engine: onPhone === undefined ? 'machine' : 'phone',
        machine,
        banner: onPhone ?? null,
        notice: null,
        session: mint(),
        ...(player === undefined ? {} : { player }),
      }),
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
          : { active: false, engine: 'machine', machine: current?.machine ?? '', banner: null, notice, session: '' },
      );
    },
    dismiss: ferretId => {
      const current = states.get(ferretId);
      if (current === undefined || current.active) return;
      set(ferretId, OFF);
    },
    attachLive: (ferretId, sink) => {
      if (sink === null) sinks.delete(ferretId);
      else sinks.set(ferretId, sink);
    },
    live: ferretId => sinks.get(ferretId),
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
