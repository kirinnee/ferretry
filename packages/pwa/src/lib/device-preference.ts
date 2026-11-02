/**
 * ONE READER PREFERENCE KEPT ON THIS DEVICE: how this browser shows something, never daemon data.
 *
 * A value in the browser's storage under one key, parsed on every read so a damaged or foreign value is
 * the default, live across this tab (a change event) and every other tab (the storage event). When the
 * browser refuses storage — private modes, a full quota, a privacy setting that makes even touching it
 * throw — the value still holds for this page, it just does not survive a reload.
 */
import { useSyncExternalStore } from 'react';

export interface DevicePreference<T extends string> {
  readonly key: string;
  readonly fallback: T;
  readonly parse: (raw: string | null) => T;
  readonly read: () => T;
  readonly write: (value: T) => void;
  /** The live value, with the default for static rendering. */
  readonly use: () => T;
}

/** Browser privacy settings may make even accessing localStorage throw. */
const browserStorage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

/** A preference stored under `key`, one of `values`, `fallback` whenever it is anything else. */
export const devicePreference = <T extends string>(
  key: string,
  values: readonly T[],
  fallback: T,
): DevicePreference<T> => {
  /** Same-tab change signal; the browser storage event only reaches other tabs. */
  const changeEvent = `ferretry:preference-change:${key}`;
  /** Falls back to this value when storage is unavailable or refuses a write. */
  let volatile: T | null = null;
  const parse = (raw: string | null): T => (values.find(value => value === raw) ?? fallback) as T;
  const read = (): T => {
    if (volatile !== null) return volatile;
    const storage = browserStorage();
    if (storage === null) return fallback;
    try {
      return parse(storage.getItem(key));
    } catch {
      return fallback;
    }
  };
  const write = (value: T): void => {
    volatile = value;
    const storage = browserStorage();
    if (storage !== null) {
      try {
        storage.setItem(key, value);
      } catch {
        // The in-page setting stays effective even if it cannot survive reload.
      }
    }
    try {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(changeEvent));
    } catch {
      // An event shim must not make the setting itself fail.
    }
  };
  const subscribe = (onChange: () => void): (() => void) => {
    const target = typeof window === 'undefined' ? undefined : window;
    if (target === undefined) return () => {};
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      volatile = null;
      onChange();
    };
    target.addEventListener(changeEvent, onChange);
    target.addEventListener('storage', onStorage);
    return () => {
      target.removeEventListener(changeEvent, onChange);
      target.removeEventListener('storage', onStorage);
    };
  };
  const use = (): T => useSyncExternalStore(subscribe, read, () => fallback);
  return { key, fallback, parse, read, write, use };
};
