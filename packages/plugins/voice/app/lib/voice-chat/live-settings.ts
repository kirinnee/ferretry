/**
 * SOLE OWNER of the `fy:voice:live-settings` browser-storage key: this device's voice-chat settings
 * (F137 slice 2 — "Auto-read replies"). Same rules as `fy:voice:stt-settings` (`lib/stt/stt-settings.ts`), kept
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
import { clampSpeechRate, DEFAULT_SPEECH_RATE } from './voice-choice.ts';
import { LIVE_VOICE_STORAGE_KEY } from '../storage-names.ts';

export const LIVE_VOICE_SETTINGS_KEY = LIVE_VOICE_STORAGE_KEY;
const LIVE_VOICE_SETTINGS_VERSION = 1;
const READABLE_VERSIONS: readonly number[] = [LIVE_VOICE_SETTINGS_VERSION];

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
}

export const DEFAULT_LIVE_VOICE_SETTINGS: LiveVoiceSettings = Object.freeze({
  v: LIVE_VOICE_SETTINGS_VERSION,
  autoRead: false,
  voiceId: null,
  rate: DEFAULT_SPEECH_RATE,
  maxSeconds: DEFAULT_READING_SECONDS,
  whatToRead: 'last',
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
  return { v: LIVE_VOICE_SETTINGS_VERSION, ...fields };
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
