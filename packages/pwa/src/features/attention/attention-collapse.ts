/**
 * SOLE OWNER of the `fy-attention-collapse-v1` browser-storage key: whether the reader folded the pinned
 * Attention card of one conversation down to a single line, on this device.
 *
 * Folding is a reader's "not now", not an answer: it tells the ferret nothing and changes no item. So it
 * is a per-device, per-conversation layout preference, never daemon state. Each conversation also
 * remembers WHICH open items the reader has already been shown, because the one thing that must undo a
 * fold is an item it has not seen — a new id arriving — and never a re-render, a refetch or a reload.
 *
 * Storage is an ordinary browser condition that may be absent or refuse writes (a private window, blocked
 * site data): every read and write is guarded, and the fold still works for the rest of the tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';

export const ATTENTION_COLLAPSE_KEY = 'fy-attention-collapse-v1';
const ATTENTION_COLLAPSE_VERSION = 1;

/** Conversations remembered before the least recently touched is forgotten. */
const MAX_CONVERSATIONS = 64;

/** One conversation's fold: whether it is folded, and the open item ids the reader has been shown. */
export interface CollapseEntry {
  readonly collapsed: boolean;
  readonly seen: readonly string[];
}

export const EMPTY_COLLAPSE_ENTRY: CollapseEntry = Object.freeze({ collapsed: false, seen: Object.freeze([]) });

export interface CollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserCollapseStorage = (): CollapseStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: CollapseStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

const parseEntry = (value: unknown): CollapseEntry | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const seen = Array.isArray(fields.seen) ? fields.seen.filter((id): id is string => typeof id === 'string') : [];
  return { collapsed: fields.collapsed === true, seen };
};

/** Every remembered conversation, in the order it was last touched. A damaged document is an empty one. */
const readAll = (storage: CollapseStorage | undefined): Map<string, CollapseEntry> => {
  const all = new Map<string, CollapseEntry>();
  if (storage === undefined) return all;
  try {
    const raw = storage.getItem(ATTENTION_COLLAPSE_KEY);
    if (raw === null) return all;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return all;
    const document = parsed as Record<string, unknown>;
    if (document.v !== ATTENTION_COLLAPSE_VERSION) return all;
    const conversations = document.conversations;
    if (conversations === null || typeof conversations !== 'object' || Array.isArray(conversations)) return all;
    for (const [key, value] of Object.entries(conversations as Record<string, unknown>)) {
      const entry = parseEntry(value);
      if (entry !== null) all.set(key, entry);
    }
  } catch {
    return new Map();
  }
  return all;
};

export const readCollapseEntry = (storage: CollapseStorage | undefined, key: string): CollapseEntry =>
  readAll(storage).get(key) ?? EMPTY_COLLAPSE_ENTRY;

/** Writes one conversation's entry as the most recently touched; reports whether the browser kept it. */
export const writeCollapseEntry = (
  storage: CollapseStorage | undefined,
  key: string,
  entry: CollapseEntry,
): boolean => {
  if (storage === undefined) return false;
  const all = readAll(storage);
  all.delete(key);
  all.set(key, entry);
  const kept = [...all.entries()].slice(-MAX_CONVERSATIONS);
  try {
    storage.setItem(
      ATTENTION_COLLAPSE_KEY,
      JSON.stringify({ v: ATTENTION_COLLAPSE_VERSION, conversations: Object.fromEntries(kept) }),
    );
    return true;
  } catch {
    return false;
  }
};

/** The open ids this entry has not been shown. */
const unseenIds = (entry: CollapseEntry, openIds: readonly string[]): readonly string[] =>
  openIds.filter(id => !entry.seen.includes(id));

/**
 * Brings an entry up to date with the open ids now on the board. An id it has not seen unfolds the card
 * and is remembered; the same ids again change nothing. Ids no longer open are forgotten, so only a
 * genuinely new ask can ever unfold it.
 */
export const reconcileCollapse = (entry: CollapseEntry, openIds: readonly string[]): CollapseEntry => {
  const fresh = unseenIds(entry, openIds).length > 0;
  const sameSeen = entry.seen.length === openIds.length && openIds.every(id => entry.seen.includes(id));
  if (!fresh && sameSeen) return entry;
  return { collapsed: fresh ? false : entry.collapsed, seen: [...openIds] };
};

export interface AttentionCollapse {
  /** The card is folded to its line. Never true for a card the reader has not been shown yet. */
  readonly collapsed: boolean;
  readonly collapse: () => void;
  readonly expand: () => void;
}

interface KeyedEntry {
  readonly key: string;
  readonly entry: CollapseEntry;
}

/**
 * The fold of one conversation's pinned card. `loaded` is false until the board has been read: nothing is
 * decided about unseen items from a board that is not there yet.
 */
export const useAttentionCollapse = (
  scope: DaemonSessionScope,
  openIds: readonly string[],
  loaded: boolean,
  storage: CollapseStorage | undefined = browserCollapseStorage(),
): AttentionCollapse => {
  const key = daemonSessionKey(scope);
  const [held, setHeld] = useState<KeyedEntry>(() => ({ key, entry: readCollapseEntry(storage, key) }));
  let current = held;
  if (held.key !== key) {
    current = { key, entry: readCollapseEntry(storage, key) };
    setHeld(current);
  }

  const idsKey = openIds.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `idsKey` stands for `openIds`, so a new array of the same ids is no change at all.
  useEffect(() => {
    if (!loaded) return;
    const next = reconcileCollapse(current.entry, openIds);
    if (next === current.entry) return;
    setHeld({ key, entry: next });
    writeCollapseEntry(storage, key, next);
  }, [loaded, key, idsKey]);

  const idsRef = useRef(openIds);
  idsRef.current = openIds;
  const commit = useCallback(
    (collapsed: boolean): void => {
      const next: CollapseEntry = { collapsed, seen: [...idsRef.current] };
      setHeld({ key, entry: next });
      writeCollapseEntry(storage, key, next);
    },
    [key, storage],
  );

  const collapse = useCallback(() => commit(true), [commit]);
  const expand = useCallback(() => commit(false), [commit]);
  // An unseen id shows the card in this very render, before the effect has recorded it.
  const collapsed = current.entry.collapsed && openIds.length > 0 && unseenIds(current.entry, openIds).length === 0;
  return { collapsed, collapse, expand };
};

/** Whether the Attention page's list is folded to its slim rail: a layout preference of this device, never daemon state. */
const ATTENTION_LIST_RAIL_KEY = 'fy-attention-list-rail-v1';

const readListRail = (storage: CollapseStorage | undefined): boolean => {
  try {
    return storage?.getItem(ATTENTION_LIST_RAIL_KEY) === '1';
  } catch {
    return false;
  }
};

const writeListRail = (storage: CollapseStorage | undefined, rail: boolean): boolean => {
  if (storage === undefined) return false;
  try {
    storage.setItem(ATTENTION_LIST_RAIL_KEY, rail ? '1' : '0');
    return true;
  } catch {
    return false;
  }
};

/** The list-rail choice, kept on this device; it still holds for the tab when the browser refuses storage. */
export const useAttentionListRail = (
  storage: CollapseStorage | undefined = browserCollapseStorage(),
): readonly [boolean, () => void] => {
  const [rail, setRail] = useState(() => readListRail(storage));
  const toggle = useCallback(() => {
    setRail(!rail);
    writeListRail(storage, !rail);
  }, [rail, storage]);
  return [rail, toggle];
};
