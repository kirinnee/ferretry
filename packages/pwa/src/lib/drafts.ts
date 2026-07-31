import type { DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';

/** The sole browser-storage key for composer drafts. */
export const DRAFTS_KEY = 'fy-drafts-v1';
export const DRAFTS_VERSION = 1;
export const MAX_DRAFTS = 50;
export const MAX_DRAFT_LEN = 16_000;

export interface DraftEntry {
  readonly text: string;
  readonly at: number;
}

export interface DraftStore {
  readonly v: number;
  readonly drafts: Record<string, DraftEntry>;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const emptyDraftStore = (): DraftStore => ({ v: DRAFTS_VERSION, drafts: {} });

/** Invalid, legacy, or corrupted browser data is deliberately discarded. */
export const parseDraftStore = (raw: string | null): DraftStore => {
  if (!raw) return emptyDraftStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyDraftStore();
  }
  if (!parsed || typeof parsed !== 'object') return emptyDraftStore();
  const value = parsed as Record<string, unknown>;
  if (value.v !== DRAFTS_VERSION || !value.drafts || typeof value.drafts !== 'object') return emptyDraftStore();

  const drafts: Record<string, DraftEntry> = {};
  for (const [key, entry] of Object.entries(value.drafts as Record<string, unknown>)) {
    if (!key || !entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.text !== 'string' ||
      candidate.text.trim() === '' ||
      typeof candidate.at !== 'number' ||
      !Number.isFinite(candidate.at)
    )
      continue;
    drafts[key] = { text: candidate.text, at: candidate.at };
  }
  return { v: DRAFTS_VERSION, drafts };
};

export const evictDraftLru = (store: DraftStore, max = MAX_DRAFTS): DraftStore => {
  const keys = Object.keys(store.drafts);
  if (keys.length <= max) return store;
  const drafts: Record<string, DraftEntry> = {};
  for (const key of keys.sort((a, b) => (store.drafts[b]?.at ?? 0) - (store.drafts[a]?.at ?? 0)).slice(0, max)) {
    const entry = store.drafts[key];
    if (entry) drafts[key] = entry;
  }
  return { v: DRAFTS_VERSION, drafts };
};

/** Upserts a daemon-scoped draft; blank or oversized input removes it. */
export const upsertDraft = (store: DraftStore, scope: DaemonSessionScope, text: string, at: number): DraftStore => {
  const key = daemonSessionKey(scope);
  const drafts = { ...store.drafts };
  if (text.trim() === '' || text.length > MAX_DRAFT_LEN) {
    delete drafts[key];
    return { v: DRAFTS_VERSION, drafts };
  }
  drafts[key] = { text, at };
  return evictDraftLru({ v: DRAFTS_VERSION, drafts });
};

export const removeDraft = (store: DraftStore, scope: DaemonSessionScope): DraftStore => {
  const key = daemonSessionKey(scope);
  if (!(key in store.drafts)) return store;
  const drafts = { ...store.drafts };
  delete drafts[key];
  return { v: DRAFTS_VERSION, drafts };
};

/** Removes every persisted draft owned by one unpaired daemon. */
export const removeDaemonDrafts = (store: DraftStore, daemonId: DaemonId): DraftStore => {
  const drafts = { ...store.drafts };
  let changed = false;
  for (const key of Object.keys(drafts)) {
    try {
      const scope = JSON.parse(key) as unknown;
      if (!Array.isArray(scope) || scope.length !== 2 || scope[0] !== daemonId) continue;
      delete drafts[key];
      changed = true;
    } catch {
      // A malformed unknown key is ignored; normal parsing never creates one.
    }
  }
  return changed ? { v: DRAFTS_VERSION, drafts } : store;
};

/**
 * Browser draft persistence. Its public methods require a full daemon/session
 * scope so the same session ID cannot recover a draft from another daemon.
 */
export class DaemonDraftStore {
  readonly #storage: DraftStorage | undefined;

  constructor(storage: DraftStorage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage) {
    this.#storage = storage;
  }

  load(scope: DaemonSessionScope): string {
    return this.#read().drafts[daemonSessionKey(scope)]?.text ?? '';
  }

  save(scope: DaemonSessionScope, text: string, at = Date.now()): void {
    this.#write(upsertDraft(this.#read(), scope, text, at));
  }

  clear(scope: DaemonSessionScope): void {
    const store = this.#read();
    const next = removeDraft(store, scope);
    if (next !== store) this.#write(next);
  }

  clearDaemon(daemonId: DaemonId): void {
    const store = this.#read();
    const next = removeDaemonDrafts(store, daemonId);
    if (next !== store) this.#write(next);
  }

  #read(): DraftStore {
    if (!this.#storage) return emptyDraftStore();
    try {
      return parseDraftStore(this.#storage.getItem(DRAFTS_KEY));
    } catch {
      return emptyDraftStore();
    }
  }

  #write(store: DraftStore): void {
    if (!this.#storage) return;
    try {
      this.#storage.setItem(DRAFTS_KEY, JSON.stringify(store));
      return;
    } catch {
      // Quota failures are deterministic for an unchanged document. Retain
      // the newest drafts and progressively shrink the retry until it fits;
      // never make the same oversized write twice.
    }
    const maximum = Math.min(10, Object.keys(store.drafts).length - 1);
    for (let retained = maximum; retained >= 0; retained -= 1) {
      try {
        this.#storage.setItem(DRAFTS_KEY, JSON.stringify(evictDraftLru(store, retained)));
        return;
      } catch {
        // Keep shrinking. Draft persistence is best-effort and must never
        // block sending when even the empty document cannot be stored.
      }
    }
  }
}
