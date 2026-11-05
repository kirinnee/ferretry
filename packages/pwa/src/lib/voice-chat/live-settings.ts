/**
 * SOLE OWNER of the `fy-live-voice-v1` browser-storage key: this device's voice-chat settings
 * (F137 slice 2 — "Auto-read replies"). Same rules as `fy-stt-v1` (`lib/stt/stt-settings.ts`), kept
 * deliberately:
 *
 *   - VERSIONED. A payload from a version this build does not know is discarded, never half-read.
 *   - DEFENSIVE AND CAPPED. Each field is parsed by its own zod schema with a `.catch` to its default, so
 *     one bad field never costs the others, and nothing hostile or oversized survives: parsing never throws.
 *   - STORAGE DENIAL IS NORMAL. Every access is wrapped; a refused write leaves `persisted` false and the
 *     app carries on in memory.
 *   - NORMALISE ON THE WAY IN. A caller cannot persist a shape only the parser would have caught.
 *
 * DEVICE-lifetime, not daemon-scoped, on purpose: the voice you like, how fast you listen and whether a
 * reply is read aloud belong to the person and the device, and would be wrong to reset when a second
 * daemon is paired. Nothing here is a secret or a credential, and no reply text is ever stored — only the
 * choices. The store is an ordinary object with injected storage (no module singleton), so a test never
 * touches a real `localStorage`.
 */

import { z } from 'zod';
import { DEFAULT_GRACE_MS, resolveGraceMs } from './live-machine.ts';
import { PAUSE_PRESETS, type PausePreset } from './turn-endpointer.ts';
import { clampSpeechRate, DEFAULT_SPEECH_RATE } from './voice-choice.ts';

export const LIVE_VOICE_SETTINGS_KEY = 'fy-live-voice-v1';
/**
 * 2 — Live voice settings (F137 slice 6) added the pause, countdown, read-in-Live, keep-screen-on and buzz fields.
 * A version-1 payload is still read: the fields it never had take their defaults, and the buzz follows the one
 * "Live sounds" switch it did have (it used to cover tones AND buzzes), so a person who turned that off stays silent.
 */
const LIVE_VOICE_SETTINGS_VERSION = 2;
const READABLE_VERSIONS: readonly number[] = [1, LIVE_VOICE_SETTINGS_VERSION];

/** A voice id is the browser's `voiceURI`; nothing longer than this is a real one. */
export const MAX_VOICE_ID_CHARS = 200;

const MIN_READING_SECONDS = 30;
const MAX_READING_SECONDS = 3600;
const DEFAULT_READING_SECONDS = 60;

/** What the max-length picker offers. `null` is "No limit". */
export const READING_LENGTH_OPTIONS: readonly { readonly seconds: number | null; readonly label: string }[] = [
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: null, label: 'No limit' },
];

export const WHAT_TO_READ_OPTIONS = [
  {
    id: 'last',
    label: 'Last message of the turn',
    description: 'Only the final message the ferret writes before it hands the turn back to you.',
  },
  {
    id: 'every',
    label: 'Every message',
    description: 'All the messages the ferret wrote in that turn, in order — including “Let me look…” ones.',
  },
] as const;

type WhatToReadId = (typeof WHAT_TO_READ_OPTIONS)[number]['id'];

/** How long a quiet has to last before Live decides you have finished: the endpointer's three named lengths. */
export const PAUSE_OPTIONS: readonly {
  readonly id: PausePreset;
  readonly label: string;
  readonly seconds: number;
  readonly description: string;
}[] = [
  {
    id: 'quick',
    label: 'Quick',
    seconds: PAUSE_PRESETS.quick / 1000,
    description: 'Sends soon after you stop. Best in a quiet room and for short sentences.',
  },
  {
    id: 'normal',
    label: 'Normal',
    seconds: PAUSE_PRESETS.normal / 1000,
    description: 'Waits a little over a second. Works for most people.',
  },
  {
    id: 'thinker',
    label: 'Thinker',
    seconds: PAUSE_PRESETS.thinker / 1000,
    description: 'Waits longer, so you can stop and think mid-sentence without being cut off.',
  },
];

/** The countdown picker's steps, in ms: 0 (send at once) to 5 s in half-seconds. */
export const COUNTDOWN_STEP_MS = 500;
export const COUNTDOWN_MAX_MS = 5_000;

export interface LiveVoiceSettings {
  readonly v: typeof LIVE_VOICE_SETTINGS_VERSION;
  /** Read each finished reply aloud on its own. OFF by default: nothing speaks unless the person asks. */
  readonly autoRead: boolean;
  /** The chosen voice (`SpeakerVoice.id`), or null for the device's best pick. */
  readonly voiceId: string | null;
  /** 0.8 – 2.0. */
  readonly rate: number;
  /** The longest one reading runs, in seconds, or null for no limit. */
  readonly maxSeconds: number | null;
  readonly whatToRead: WhatToReadId;
  /** Live's short tones (and, on Android, a short buzz) at listening, sent, reply ready and stopped. ON by default. */
  readonly earcons: boolean;
  /** How long a quiet ends your turn in Live: quick 0.9 s, normal 1.5 s, thinker 2.5 s. */
  readonly pause: PausePreset;
  /** The visible countdown between the end of your turn and the send, ms (0–5000). 0 sends at once. */
  readonly countdownMs: number;
  /** Live reads each reply aloud, then listens again. ON by default; separate from "Auto-read replies" outside Live. */
  readonly liveRead: boolean;
  /** Live asks the browser to keep the screen on while it listens. ON by default. */
  readonly keepAwake: boolean;
  /** Live's short buzz on an Android phone at "sent" and "reply ready". ON by default. */
  readonly haptics: boolean;
  /** The one-time "Using a screen reader?" hint was answered (Got it, or Turn it off). */
  readonly screenReaderHintSeen: boolean;
}

export const DEFAULT_LIVE_VOICE_SETTINGS: LiveVoiceSettings = Object.freeze({
  v: LIVE_VOICE_SETTINGS_VERSION,
  autoRead: false,
  voiceId: null,
  rate: DEFAULT_SPEECH_RATE,
  maxSeconds: DEFAULT_READING_SECONDS,
  whatToRead: 'last',
  earcons: true,
  pause: 'normal',
  countdownMs: DEFAULT_GRACE_MS,
  liveRead: true,
  keepAwake: true,
  haptics: true,
  screenReaderHintSeen: false,
});

const fieldsSchema = z.object({
  autoRead: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.autoRead),
  voiceId: z
    .string()
    .max(MAX_VOICE_ID_CHARS)
    .transform(id => (id === '' ? null : id))
    .nullable()
    .catch(DEFAULT_LIVE_VOICE_SETTINGS.voiceId),
  rate: z.number().transform(clampSpeechRate).catch(DEFAULT_LIVE_VOICE_SETTINGS.rate),
  maxSeconds: z
    .number()
    .int()
    .min(MIN_READING_SECONDS)
    .max(MAX_READING_SECONDS)
    .nullable()
    .catch(DEFAULT_LIVE_VOICE_SETTINGS.maxSeconds),
  whatToRead: z.enum(['last', 'every']).catch(DEFAULT_LIVE_VOICE_SETTINGS.whatToRead),
  earcons: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.earcons),
  pause: z.enum(['quick', 'normal', 'thinker']).catch(DEFAULT_LIVE_VOICE_SETTINGS.pause),
  countdownMs: z.number().transform(resolveGraceMs).catch(DEFAULT_LIVE_VOICE_SETTINGS.countdownMs),
  liveRead: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.liveRead),
  keepAwake: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.keepAwake),
  // Absent (or bad) → undefined here and resolved below to follow `earcons`.
  haptics: z.boolean().optional().catch(undefined),
  screenReaderHintSeen: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.screenReaderHintSeen),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Defensive parse. Never throws, always returns a usable record. */
export const parseLiveVoiceSettings = (raw: string | null): LiveVoiceSettings => {
  if (raw === null) return DEFAULT_LIVE_VOICE_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LIVE_VOICE_SETTINGS;
  }
  if (!isRecord(parsed)) return DEFAULT_LIVE_VOICE_SETTINGS;
  // biome-ignore lint/complexity/useLiteralKeys: `parsed` is an index signature (`noPropertyAccessFromIndexSignature`), so the key is read by name.
  const version = parsed['v'];
  if (typeof version !== 'number' || !READABLE_VERSIONS.includes(version)) return DEFAULT_LIVE_VOICE_SETTINGS;
  const fields = fieldsSchema.parse(parsed);
  return { v: LIVE_VOICE_SETTINGS_VERSION, ...fields, haptics: fields.haptics ?? fields.earcons };
};

/** What one reading needs of the settings: the voice, the speed and how long it may run. */
export const readOptionsOf = (
  settings: LiveVoiceSettings,
): { readonly voiceId: string | null; readonly rate: number; readonly maxSeconds: number | null } => ({
  voiceId: settings.voiceId,
  rate: settings.rate,
  maxSeconds: settings.maxSeconds,
});

export type LiveVoiceSettingsPatch = Readonly<Partial<Omit<LiveVoiceSettings, 'v'>>>;

/** Normalise before writing, so a caller cannot persist an out-of-range shape. */
export const normaliseLiveVoiceSettings = (next: LiveVoiceSettings): LiveVoiceSettings =>
  parseLiveVoiceSettings(JSON.stringify(next));

/** The storage surface actually used: injectable, and a denied or absent one is an ordinary path. */
export interface LiveVoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One immutable, identity-stable snapshot in an external store (what `useSyncExternalStore` needs). */
export class LiveVoiceSettingsStore {
  readonly #storage: LiveVoiceStorage | null;
  readonly #listeners = new Set<() => void>();
  #snapshot: LiveVoiceSettings;
  #persisted = true;

  constructor(storage: LiveVoiceStorage | null = null) {
    this.#storage = storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(LIVE_VOICE_SETTINGS_KEY) ?? null;
    } catch {
      // Accessing storage at all throws when the browser has blocked it.
    }
    this.#snapshot = parseLiveVoiceSettings(raw);
  }

  /** Bound so it can be handed straight to `useSyncExternalStore`. */
  readonly get = (): LiveVoiceSettings => this.#snapshot;

  /** `false` once a write has been refused, so the screen can say the choice will not survive a reload. */
  get persisted(): boolean {
    return this.#persisted;
  }

  /** Partial update; unspecified fields keep their value. A patch that changes nothing keeps the snapshot. */
  update(patch: LiveVoiceSettingsPatch): LiveVoiceSettings {
    const next = normaliseLiveVoiceSettings({ ...this.#snapshot, ...patch, v: LIVE_VOICE_SETTINGS_VERSION });
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return this.#snapshot;
    this.#snapshot = next;
    this.#persisted = this.#persist(next);
    for (const listener of [...this.#listeners]) listener();
    return next;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Re-read storage (another tab wrote) and publish it. A storage that refuses the read changes nothing. */
  reload(): LiveVoiceSettings {
    // No storage means nothing to re-read: the in-memory choice is the only copy there is.
    if (this.#storage === null) return this.#snapshot;
    let raw: string | null = null;
    try {
      raw = this.#storage.getItem(LIVE_VOICE_SETTINGS_KEY);
    } catch {
      return this.#snapshot;
    }
    const next = parseLiveVoiceSettings(raw);
    if (JSON.stringify(next) !== JSON.stringify(this.#snapshot)) {
      this.#snapshot = next;
      for (const listener of [...this.#listeners]) listener();
    }
    return this.#snapshot;
  }

  #persist(value: LiveVoiceSettings): boolean {
    if (this.#storage === null) return false;
    try {
      this.#storage.setItem(LIVE_VOICE_SETTINGS_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
}
