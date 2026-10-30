/**
 * SOLE OWNER of the `fy-agenda-ask-pinned-v1` browser-storage key: whether a phone keeps an agenda item's ask
 * pinned in the item's one-line head (ⓘ), or reads it as the body's first paragraph (the default).
 *
 * A property of the reader's screen, remembered on this device only — the shape of `table-view-preference.ts`:
 * an injected storage, a defensive parse, and a denied or missing storage treated as the default.
 */

/** The sole browser-storage key for the pinned ask. */
export const ASK_PIN_KEY = 'fy-agenda-ask-pinned-v1';

export interface AskPinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): AskPinStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: AskPinStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** Pinned only when this device said so; anything else — a stale value, no storage, a denied one — is not. */
export const readAskPinned = (storage: AskPinStorage | undefined = browserStorage()): boolean => {
  try {
    return storage?.getItem(ASK_PIN_KEY) === '1';
  } catch {
    return false;
  }
};

/** Remembers the choice; a storage that refuses only means it is not remembered. */
export const writeAskPinned = (pinned: boolean, storage: AskPinStorage | undefined = browserStorage()): void => {
  try {
    storage?.setItem(ASK_PIN_KEY, pinned ? '1' : '0');
  } catch {
    // A full or denied storage: the choice holds for this view only.
  }
};
