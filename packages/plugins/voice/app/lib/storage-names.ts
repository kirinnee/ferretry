/**
 * EVERY BROWSER-SIDE NAME THIS HALF USES (§9.4), in one place. The shell's `storage/names.ts` owns the grammar —
 * localStorage `fy:<id>:<name>`, IndexedDB `fy-<id>` (one database per subsystem), Cache Storage `fy:voice:<model>` for
 * speech models — and these are its results for the `voice` id, written out so the worker bundles that import them
 * pull in no shell code. A test pins each against the shell's own functions.
 */

/** localStorage: this device's dictation settings. */
export const STT_SETTINGS_STORAGE_KEY = 'fy:voice:stt-settings';
/** localStorage: what this device learned about which engines run well. */
export const SPEED_MEMORY_STORAGE_KEY = 'fy:voice:speed-memory';
/** localStorage: this device's Auto-read replies, voice and rate. */
export const LIVE_VOICE_STORAGE_KEY = 'fy:voice:live-settings';
/** localStorage: the dictation debug switch. */
export const DICTATION_DEBUG_STORAGE_KEY = 'fy:voice:dictation-debug';

/** IndexedDB: the one database this subsystem keeps, holding the sealed speed-up keys and the transcription log. */
export const VOICE_DATABASE = 'fy-voice';
export const VOICE_DATABASE_VERSION = 1;
export const SPEEDUP_KEYS_STORE = 'keys';
export const TRANSCRIPTION_LOG_STORE = 'entries';

/** Makes both object stores; each record class opens the database on its own, so either may be the first to. */
export function upgradeVoiceDatabase(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(SPEEDUP_KEYS_STORE)) database.createObjectStore(SPEEDUP_KEYS_STORE);
  if (!database.objectStoreNames.contains(TRANSCRIPTION_LOG_STORE))
    database.createObjectStore(TRANSCRIPTION_LOG_STORE, { keyPath: 'id' });
}
