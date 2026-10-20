/**
 * SOLE OWNER of the `fy-analytics-saved-queries-v1` browser-storage key: the queries a reader saved on
 * the Query page. A per-viewer convenience, so it lives in this browser only; a denied or corrupt
 * storage is an ordinary condition and reads as an empty list.
 */

export const SAVED_QUERIES_KEY = 'fy-analytics-saved-queries-v1';
export const MAX_SAVED_QUERIES = 50;
export const MAX_SAVED_NAME_CHARS = 80;

export interface SavedAnalyticsQuery {
  readonly id: string;
  readonly name: string;
  readonly query: string;
}

export interface SavedQueriesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const browserSavedQueriesStorage = (): SavedQueriesStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: SavedQueriesStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

const isSaved = (value: unknown): value is SavedAnalyticsQuery => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.query === 'string' &&
    record.id !== '' &&
    record.name.trim() !== '' &&
    record.query.trim() !== ''
  );
};

/** A stale, hand-edited or unreadable value is an empty list, never a crash. */
export const parseSavedQueries = (raw: string | null | undefined): readonly SavedAnalyticsQuery[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSaved).slice(0, MAX_SAVED_QUERIES) : [];
  } catch {
    return [];
  }
};

export const loadSavedQueries = (storage: SavedQueriesStorage | undefined): readonly SavedAnalyticsQuery[] => {
  try {
    return parseSavedQueries(storage?.getItem(SAVED_QUERIES_KEY));
  } catch {
    return [];
  }
};

/** Returns whether the list reached storage; the in-memory list still applies when it did not. */
export const persistSavedQueries = (
  storage: SavedQueriesStorage | undefined,
  queries: readonly SavedAnalyticsQuery[],
): boolean => {
  try {
    if (!storage) return false;
    storage.setItem(SAVED_QUERIES_KEY, JSON.stringify(queries));
    return true;
  } catch {
    return false;
  }
};

/** Adds one, or replaces the one with the same name (case-insensitive): a name is one query. */
export const addSavedQuery = (
  queries: readonly SavedAnalyticsQuery[],
  name: string,
  query: string,
  makeId: () => string,
): readonly SavedAnalyticsQuery[] => {
  const cleanName = name.trim().slice(0, MAX_SAVED_NAME_CHARS);
  const cleanQuery = query.trim();
  if (cleanName === '' || cleanQuery === '') return queries;
  const existing = queries.find(item => item.name.toLowerCase() === cleanName.toLowerCase());
  const entry: SavedAnalyticsQuery = { id: existing?.id ?? makeId(), name: cleanName, query: cleanQuery };
  const next = existing ? queries.map(item => (item === existing ? entry : item)) : [...queries, entry];
  return next.slice(-MAX_SAVED_QUERIES);
};

export const removeSavedQuery = (queries: readonly SavedAnalyticsQuery[], id: string): readonly SavedAnalyticsQuery[] =>
  queries.filter(item => item.id !== id);
