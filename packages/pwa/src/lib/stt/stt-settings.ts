/**
 * SOLE OWNER of the `fy-stt-v1` browser-storage key.
 *
 * Ported from kteam `ui/src/lib/stt/stt-settings.ts`, which kept the same rules
 * around a module-level singleton and a `kteam-stt-v1` key.
 *
 * Kept from kteam, deliberately:
 *   - VERSIONED. A shape change bumps the version and the old payload is
 *     discarded rather than half-read. That is a clean migration point instead
 *     of a crash on a shape this build has never seen.
 *   - DEFENSIVE AND CAPPED. Any malformed, wrong-version, oversized or hostile
 *     payload degrades to the defaults, field by field. Parsing never throws.
 *   - STORAGE DENIAL IS NORMAL. Private windows, disabled storage and quota
 *     exhaustion all throw from `localStorage`. Every access here is wrapped; a
 *     refused write leaves `persisted` false and the app carries on with
 *     in-memory settings rather than losing the reader's session to a settings
 *     save.
 *   - NORMALISE ON THE WAY IN. A caller cannot persist an out-of-range shape
 *     that only the parser would have caught on the way back out.
 *
 * WHAT CHANGED — these settings are DEVICE-lifetime, not daemon-scoped, and
 * that is a decision rather than an oversight. Nothing in the record is
 * daemon-derived: the microphone, the push-to-talk chord, the reader's
 * dictionary and their jargon belong to the person and the machine, and would
 * be wrong to reset when a second daemon is paired. `enhancementProvider` names
 * a KIND of enhancer, not a daemon; when it is `groq` the request goes to
 * whichever daemon owns the live session, resolved from that session's
 * `DaemonConnection` at call time (see `remote-enhancement.ts`), never from
 * anything stored here. No provider credential is stored here or anywhere else
 * in the browser.
 *
 * There is deliberately no migration from kteam's key or its v1–v4 payloads: no
 * Ferretry bundle ever wrote them, so a kteam-shaped blob is a clean reset.
 *
 * The store is an ordinary object with injected storage rather than a module
 * singleton, so a test never touches a real `localStorage` and two suites
 * cannot see each other's writes.
 */

import {
  DEFAULT_DICTATION_SHORTCUT,
  type DictationShortcutBinding,
} from '../../features/settings/dictation-shortcut.ts';
import { MAX_USER_CONTEXT_CHARS, parseDictionary, type DictionaryParse } from './enhancement.ts';

export const STT_SETTINGS_KEY = 'fy-stt-v1';
export const STT_SETTINGS_VERSION = 1;

/**
 * Dictionary caps, mirrored from `enhancement.ts` so a textarea can refuse
 * before the parser has to.
 */
export const MAX_DICTIONARY_LINES = 200;
export const MAX_DICTIONARY_LINE_LENGTH = 160;
export const MAX_ENHANCEMENT_MODEL_CHARS = 120;

export const ENHANCEMENT_PROVIDERS = [
  { id: 'local', label: 'On-device word correction' },
  { id: 'groq', label: 'Groq correction' },
] as const;

export type EnhancementProviderId = (typeof ENHANCEMENT_PROVIDERS)[number]['id'];
export const DEFAULT_GROQ_ENHANCEMENT_MODEL = 'llama-3.1-8b-instant';

/**
 * The free-text context cap, re-exported so the settings textarea can carry
 * the same `maxLength` the parser enforces on the way back in.
 */
export { MAX_USER_CONTEXT_CHARS };

export interface SttSettings {
  readonly v: typeof STT_SETTINGS_VERSION;
  /**
   * Master resource switch. False means capture cannot start and any resident
   * local ONNX sessions are released.
   */
  readonly enabled: boolean;
  /**
   * Word-only enhancement. On by default: it only ever swaps whole words, and
   * a verifier throws the whole result away if it did anything else.
   */
  readonly enhancement: boolean;
  /**
   * One term per line, exactly as the reader typed it. Parsed on use, not on
   * save, so a half-typed line is never destroyed by a round trip.
   */
  readonly dictionary: readonly string[];
  /**
   * Free text mined for extra vocabulary — project jargon, names, a pasted
   * glossary. Stored verbatim; extraction happens on use.
   */
  readonly userContext: string;
  /**
   * Post-dictation correction provider. `local` is the deterministic enhancer;
   * `groq` calls the session's daemon, whose environment owns the API key.
   */
  readonly enhancementProvider: EnhancementProviderId;
  /** Non-secret provider model id. The Groq API key is deliberately absent. */
  readonly enhancementModel: string;
  /**
   * Browser-local push-to-talk binding. Alt (either side) is the default, but
   * it is data, never a hardcoded event-handler special case.
   */
  readonly shortcut: DictationShortcutBinding;
}

export const DEFAULT_STT_SETTINGS: SttSettings = Object.freeze({
  v: STT_SETTINGS_VERSION,
  enabled: true,
  enhancement: true,
  dictionary: Object.freeze([]) as readonly string[],
  userContext: '',
  enhancementProvider: 'local',
  enhancementModel: DEFAULT_GROQ_ENHANCEMENT_MODEL,
  shortcut: DEFAULT_DICTATION_SHORTCUT,
});

const SHORTCUT_MODIFIERS = ['Meta', 'Control', 'Alt', 'Shift'] as const;
type ShortcutModifier = (typeof SHORTCUT_MODIFIERS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decode a persisted push-to-talk chord.
 *
 * The parse lives with persistence rather than beside the chord policy: the
 * policy answers "may a reader bind this?", which is a question about a live
 * keyboard event, while this answers "what did the last release write?", which
 * is a question about a byte string that may be anything at all.
 */
export const parseDictationShortcut = (value: unknown): DictationShortcutBinding => {
  if (!isRecord(value)) return DEFAULT_DICTATION_SHORTCUT;
  const code = typeof value.code === 'string' ? value.code.slice(0, 48) : '';
  const key = typeof value.key === 'string' ? value.key.slice(0, 24) : '';
  if (code === '' || key === '') return DEFAULT_DICTATION_SHORTCUT;
  const raw = Array.isArray(value.modifiers) ? value.modifiers : [];
  // Rebuilt in canonical order from a fixed vocabulary, so a hand-edited
  // payload can neither reorder the chord nor smuggle an unknown modifier in.
  const modifiers = SHORTCUT_MODIFIERS.filter((modifier: ShortcutModifier) => raw.includes(modifier));
  return { code, key, modifiers };
};

const parseDictionaryLines = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const line of value) {
    if (typeof line !== 'string') continue;
    if (lines.length >= MAX_DICTIONARY_LINES) break;
    lines.push(line.slice(0, MAX_DICTIONARY_LINE_LENGTH));
  }
  return lines;
};

const parseProvider = (value: unknown): EnhancementProviderId =>
  ENHANCEMENT_PROVIDERS.some(provider => provider.id === value)
    ? (value as EnhancementProviderId)
    : DEFAULT_STT_SETTINGS.enhancementProvider;

const parseModel = (value: unknown): string => {
  if (typeof value !== 'string') return DEFAULT_STT_SETTINGS.enhancementModel;
  return value.trim().slice(0, MAX_ENHANCEMENT_MODEL_CHARS) || DEFAULT_STT_SETTINGS.enhancementModel;
};

/** Defensive parse. Never throws, always returns a usable record. */
export const parseSttSettings = (raw: string | null): SttSettings => {
  if (raw === null) return DEFAULT_STT_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_STT_SETTINGS;
  }
  if (!isRecord(parsed) || parsed.v !== STT_SETTINGS_VERSION) return DEFAULT_STT_SETTINGS;
  return {
    v: STT_SETTINGS_VERSION,
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_STT_SETTINGS.enabled,
    enhancement: typeof parsed.enhancement === 'boolean' ? parsed.enhancement : DEFAULT_STT_SETTINGS.enhancement,
    dictionary: parseDictionaryLines(parsed.dictionary),
    userContext: typeof parsed.userContext === 'string' ? parsed.userContext.slice(0, MAX_USER_CONTEXT_CHARS) : '',
    enhancementProvider: parseProvider(parsed.enhancementProvider),
    enhancementModel: parseModel(parsed.enhancementModel),
    shortcut: parseDictationShortcut(parsed.shortcut),
  };
};

export type SttSettingsPatch = Readonly<Partial<Omit<SttSettings, 'v'>>>;

/**
 * Normalise before writing, so a caller cannot persist an out-of-range shape
 * that only the parser would have caught on the way back in.
 */
export const normaliseSttSettings = (next: SttSettings): SttSettings => parseSttSettings(JSON.stringify(next));

/**
 * The storage surface actually used. Injectable so tests never touch a real
 * `localStorage` and so a denied or absent one is an ordinary code path.
 */
export interface SttSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A synchronously readable external store holding one immutable snapshot.
 *
 * The snapshot is IDENTITY-STABLE between real changes, which is what
 * `useSyncExternalStore` requires: returning a freshly parsed object on every
 * render would spin React forever.
 */
export class SttSettingsStore {
  readonly #storage: SttSettingsStorage | null;
  readonly #listeners = new Set<() => void>();
  #snapshot: SttSettings;
  #persisted = true;

  constructor(storage: SttSettingsStorage | null = null) {
    this.#storage = storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(STT_SETTINGS_KEY) ?? null;
    } catch {
      // Accessing storage at all throws when the browser has blocked it.
    }
    this.#snapshot = parseSttSettings(raw);
  }

  /** Bound so it can be handed straight to `useSyncExternalStore`. */
  readonly get = (): SttSettings => this.#snapshot;

  /**
   * `false` once a write has been refused by storage, so the settings screen
   * can say so instead of pretending the choice was saved.
   */
  get persisted(): boolean {
    return this.#persisted;
  }

  /** Partial update; unspecified fields keep their current value. */
  update(patch: SttSettingsPatch): SttSettings {
    const next = normaliseSttSettings({ ...this.#snapshot, ...patch, v: STT_SETTINGS_VERSION });
    this.#snapshot = next;
    this.#persisted = this.#persist(next);
    for (const listener of [...this.#listeners]) listener();
    return next;
  }

  /**
   * Subscribe to changes. The returned function unsubscribes.
   *
   * Bound, because `useSyncExternalStore` re-subscribes whenever the function
   * identity changes and a method reference would change on every render.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Re-read storage and publish the result.
   *
   * The browser's `storage` event fires in OTHER tabs only, so a settings
   * screen and a composer in the SAME tab would not see each other's changes
   * without the notification `update` already sends. This is the other half:
   * the cross-tab listener calls it, and `key === null` (a whole-storage
   * clear) counts as a change to us too.
   */
  reload(): SttSettings {
    let raw: string | null = null;
    try {
      raw = this.#storage?.getItem(STT_SETTINGS_KEY) ?? null;
    } catch {
      // A storage that has started refusing reads leaves the snapshot alone.
      return this.#snapshot;
    }
    this.#snapshot = parseSttSettings(raw);
    for (const listener of [...this.#listeners]) listener();
    return this.#snapshot;
  }

  #persist(value: SttSettings): boolean {
    if (this.#storage === null) return false;
    try {
      this.#storage.setItem(STT_SETTINGS_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Parse the reader's dictionary lines into enhancer entries. Here so callers
 * need only this module to go from storage to a usable dictionary.
 */
export const sttDictionary = (settings: SttSettings): DictionaryParse => parseDictionary(settings.dictionary);
