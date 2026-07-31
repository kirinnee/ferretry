/**
 * The sole owner of the Markdown-composer display preference.
 *
 * This is intentionally a reader preference, not daemon data: it affects only
 * how the current browser paints a textarea, so daemon-scoping it would make a
 * daemon switch unexpectedly change the reader's editor chrome.
 */
import { useSyncExternalStore } from 'react';

export const MD_COMPOSE_KEY = 'fy-markdown-composer-v1';
export type MdComposePref = 'on' | 'off';
export const MD_COMPOSE_DEFAULT: MdComposePref = 'off';

/** Same-tab change signal; the browser storage event only reaches other tabs. */
const CHANGE_EVENT = 'ferretry:markdown-composer-change';

/** Falls back to this value when storage is unavailable or refuses a write. */
let volatilePref: MdComposePref | null = null;

export const parseMdComposePref = (raw: string | null): MdComposePref =>
  raw === 'on' || raw === 'off' ? raw : MD_COMPOSE_DEFAULT;

/** Browser privacy settings may make even accessing localStorage throw. */
const browserStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

export const readMdComposePref = (): MdComposePref => {
  if (volatilePref !== null) return volatilePref;
  const storage = browserStorage();
  if (storage === null) return MD_COMPOSE_DEFAULT;
  try {
    return parseMdComposePref(storage.getItem(MD_COMPOSE_KEY));
  } catch {
    return MD_COMPOSE_DEFAULT;
  }
};

export const writeMdComposePref = (pref: MdComposePref): void => {
  volatilePref = pref;
  const storage = browserStorage();
  if (storage !== null) {
    try {
      storage.setItem(MD_COMPOSE_KEY, pref);
    } catch {
      // The in-page setting stays effective even if it cannot survive reload.
    }
  }
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // An event shim must not make the setting itself fail.
  }
};

const subscribe = (onChange: () => void): (() => void) => {
  const target = typeof window === 'undefined' ? undefined : window;
  if (target === undefined) return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== MD_COMPOSE_KEY) return;
    volatilePref = null;
    onChange();
  };
  target.addEventListener(CHANGE_EVENT, onChange);
  target.addEventListener('storage', onStorage);
  return () => {
    target.removeEventListener(CHANGE_EVENT, onChange);
    target.removeEventListener('storage', onStorage);
  };
};

/** A live browser preference with a deterministic static-rendering snapshot. */
export const useMdComposePref = (): MdComposePref =>
  useSyncExternalStore(subscribe, readMdComposePref, () => MD_COMPOSE_DEFAULT);
