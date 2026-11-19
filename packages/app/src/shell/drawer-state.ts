import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, removeRecord, writeRecord } from '../storage/records.ts';

/**
 * WHETHER THE LEFT DRAWER IS A SLIM RAIL, remembered on THIS device (a local preference, never a daemon's): the person who
 * collapsed it on a laptop finds it collapsed on the next visit. The browser's storage is the only copy; a browser that
 * refuses it (a private window) keeps the choice in memory for the visit and never throws. Shaped for `useSyncExternalStore`.
 *
 * The phone's overlay (open or shut) is NOT remembered: a phone always starts with the drawer shut, and the page is under it.
 */

const StoredSchema = z.strictObject({ collapsed: z.boolean() });

/** The browser's local storage, or `null` when the browser will not hand it out. */
function deviceStorage(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

class DrawerState {
  readonly #listeners = new Set<() => void>();
  /** What this visit chose, for a browser that keeps nothing. */
  #memory: boolean | undefined;
  #open = false;

  /** Collapsed to the rail: the stored choice, else this visit's, else `undefined` (the layout's own default applies). */
  readonly collapsed = (): boolean | undefined =>
    readRecord(deviceStorage(), APP_STORAGE.drawer, StoredSchema)?.collapsed ?? this.#memory;

  setCollapsed(collapsed: boolean): void {
    this.#memory = collapsed;
    writeRecord(deviceStorage(), APP_STORAGE.drawer, { collapsed });
    this.#changed();
  }

  /** Back to "nothing chosen": the layout's own default applies again (and a test starts clean). */
  forget(): void {
    this.#memory = undefined;
    removeRecord(deviceStorage(), APP_STORAGE.drawer);
    this.#changed();
  }

  /** Flips the choice, from what is showing now (`byDefault` when nothing was chosen yet). */
  toggleCollapsed(byDefault: boolean): void {
    this.setCollapsed(!(this.collapsed() ?? byDefault));
  }

  /** The phone's overlay is showing. */
  readonly open = (): boolean => this.#open;

  setOpen(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    this.#changed();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    // Another tab of this device changed the choice: take it on.
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === APP_STORAGE.drawer) listener();
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      this.#listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  };

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** The one the shell's frame shares. */
export const drawerState = new DrawerState();

/** Whether the drawer is collapsed to the rail (wide: this device's choice, else `byDefault`), and the setter. */
export function useDrawerCollapsed(byDefault: boolean): readonly [boolean, (next: boolean) => void] {
  const chosen = useSyncExternalStore(drawerState.subscribe, drawerState.collapsed, () => undefined);
  return [chosen ?? byDefault, next => drawerState.setCollapsed(next)];
}

/** Whether the phone's overlay drawer is showing, and the setter. */
export function useDrawerOpen(): readonly [boolean, (next: boolean) => void] {
  const open = useSyncExternalStore(drawerState.subscribe, drawerState.open, () => false);
  return [open, next => drawerState.setOpen(next)];
}
