/**
 * SOLE OWNER of the `fy-live-voice-v1` and `fy-live-voice-extras-v1` browser-storage keys: this device's
 * voice-chat settings (F137 slice 2 — "Auto-read replies"; slice 6 — Live voice). Same rules as `fy-stt-v1` (`lib/stt/stt-settings.ts`), kept
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
 *
 * TWO KEYS, BECAUSE TWO BUILDS CAN SHARE ONE BROWSER. Slice 5 shipped a parser for `fy-live-voice-v1` that
 * reads only `v: 1` and rewrites the whole record on every change. Slice 6 therefore never changes that key's
 * shape: it keeps writing the version-1 fields there (voice, speed, length, what to read, auto-read, sounds) so an
 * older tab still reads them, and keeps its own fields (pause, countdown, read in Live, keep screen on, buzz, the
 * screen-reader hint) in `fy-live-voice-extras-v1`, which an older build neither reads nor writes — so its next
 * save cannot erase them. A new tab reads both, and an old tab's save of the shared fields is simply the newest
 * word on them. Neither direction loses a choice.
 */

import { z } from 'zod';
import { DEFAULT_GRACE_MS, NO_COUNTDOWN_MS, resolveCountdownMs } from './live-machine.ts';
import { PAUSE_PRESETS, type PausePreset } from './turn-endpointer.ts';
import { clampSpeechRate, DEFAULT_SPEECH_RATE } from './voice-choice.ts';

/** The version-1 record older builds read: voice, speed, length, what to read, auto-read and sounds. Never reshaped. */
export const LIVE_VOICE_SETTINGS_KEY = 'fy-live-voice-v1';
/** Slice 6's own fields, in a record an older build does not know exists (so its save cannot erase them). */
export const LIVE_VOICE_EXTRAS_KEY = 'fy-live-voice-extras-v1';
/** Both stored records are version 1 of their own shape; the in-memory snapshot is the merge of the two. */
const STORED_VERSION = 1;
/**
 * The snapshot's own version: 2 — Live voice settings (F137 slice 6) added the pause, countdown, read-in-Live,
 * keep-screen-on and buzz fields. A person with only the version-1 record gets those at their defaults, and the buzz
 * follows the one "Live sounds" switch the old record had (it used to cover tones AND buzzes), so a person who
 * turned that off stays silent.
 */
const LIVE_VOICE_SETTINGS_VERSION = 2;

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
  /** The visible countdown between the end of your turn and the send, ms: always 500–5000, never 0. */
  readonly countdownMs: number;
  /**
   * The person's deliberate "Send without a countdown": the ONLY way Live sends the moment it has your words.
   * Off by default; a stored value that is not exactly `true` is off. `countdownMs` is kept while it is on, so
   * turning it off brings the old countdown back.
   */
  readonly sendWithoutCountdown: boolean;
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
  sendWithoutCountdown: false,
  liveRead: true,
  keepAwake: true,
  haptics: true,
  screenReaderHintSeen: false,
});

/** The version-1 record: exactly the fields an older build parses, with the same per-field fallbacks. */
const sharedSchema = z.object({
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
});

/** Slice 6's record. `countdownMs` can never parse to 0; only `sendWithoutCountdown === true` sends at once. */
const extrasSchema = z.object({
  pause: z.enum(['quick', 'normal', 'thinker']).catch(DEFAULT_LIVE_VOICE_SETTINGS.pause),
  countdownMs: z.number().transform(resolveCountdownMs).catch(DEFAULT_LIVE_VOICE_SETTINGS.countdownMs),
  sendWithoutCountdown: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.sendWithoutCountdown),
  liveRead: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.liveRead),
  keepAwake: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.keepAwake),
  // Absent (or bad) → undefined here and resolved below to follow `earcons`.
  haptics: z.boolean().optional().catch(undefined),
  screenReaderHintSeen: z.boolean().catch(DEFAULT_LIVE_VOICE_SETTINGS.screenReaderHintSeen),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored record's fields, or an empty record (every field then takes its default) for anything that is not a readable one. */
const storedRecord = (raw: string | null): Record<string, unknown> => {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  // biome-ignore lint/complexity/useLiteralKeys: `parsed` is an index signature (`noPropertyAccessFromIndexSignature`), so the key is read by name.
  return parsed['v'] === STORED_VERSION ? parsed : {};
};

/**
 * Defensive parse of the two stored records. Never throws, always returns a usable snapshot. A record that is
 * missing, unreadable or from a version this build does not know gives its fields their defaults; the other
 * record is unaffected.
 */
export const parseLiveVoiceSettings = (raw: string | null, rawExtras: string | null = null): LiveVoiceSettings => {
  const shared = sharedSchema.parse(storedRecord(raw));
  const extras = extrasSchema.parse(storedRecord(rawExtras));
  return { v: LIVE_VOICE_SETTINGS_VERSION, ...shared, ...extras, haptics: extras.haptics ?? shared.earcons };
};

/** The two records as they are written: the version-1 projection, and slice 6's own fields. */
export const serialiseLiveVoiceSettings = (
  settings: LiveVoiceSettings,
): { readonly shared: string; readonly extras: string } => ({
  shared: JSON.stringify({
    v: STORED_VERSION,
    autoRead: settings.autoRead,
    voiceId: settings.voiceId,
    rate: settings.rate,
    maxSeconds: settings.maxSeconds,
    whatToRead: settings.whatToRead,
    earcons: settings.earcons,
  }),
  extras: JSON.stringify({
    v: STORED_VERSION,
    pause: settings.pause,
    countdownMs: settings.countdownMs,
    sendWithoutCountdown: settings.sendWithoutCountdown,
    liveRead: settings.liveRead,
    keepAwake: settings.keepAwake,
    haptics: settings.haptics,
    screenReaderHintSeen: settings.screenReaderHintSeen,
  }),
});

/** The countdown Live starts with, in ms: 0 only when the person chose "Send without a countdown". */
export const graceMsOf = (settings: LiveVoiceSettings): number =>
  settings.sendWithoutCountdown ? NO_COUNTDOWN_MS : settings.countdownMs;

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
export const normaliseLiveVoiceSettings = (next: LiveVoiceSettings): LiveVoiceSettings => {
  const { shared, extras } = serialiseLiveVoiceSettings(next);
  return parseLiveVoiceSettings(shared, extras);
};

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
    this.#snapshot = this.#read() ?? DEFAULT_LIVE_VOICE_SETTINGS;
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
    // No storage (or one that refuses the read) means nothing to re-read: the in-memory choice is the only copy.
    const next = this.#read();
    if (next === null) return this.#snapshot;
    if (JSON.stringify(next) !== JSON.stringify(this.#snapshot)) {
      this.#snapshot = next;
      for (const listener of [...this.#listeners]) listener();
    }
    return this.#snapshot;
  }

  /** Both records, merged; `null` when there is no storage or it refuses the read. */
  #read(): LiveVoiceSettings | null {
    if (this.#storage === null) return null;
    try {
      return parseLiveVoiceSettings(
        this.#storage.getItem(LIVE_VOICE_SETTINGS_KEY),
        this.#storage.getItem(LIVE_VOICE_EXTRAS_KEY),
      );
    } catch {
      // Accessing storage at all throws when the browser has blocked it.
      return null;
    }
  }

  /** Writes both records, each on its own: one refused write never stops the other. */
  #persist(value: LiveVoiceSettings): boolean {
    const storage = this.#storage;
    if (storage === null) return false;
    const { shared, extras } = serialiseLiveVoiceSettings(value);
    const write = (key: string, text: string): boolean => {
      try {
        storage.setItem(key, text);
        return true;
      } catch {
        return false;
      }
    };
    const sharedOk = write(LIVE_VOICE_SETTINGS_KEY, shared);
    const extrasOk = write(LIVE_VOICE_EXTRAS_KEY, extras);
    return sharedOk && extrasOk;
  }
}
