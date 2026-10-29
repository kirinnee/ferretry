/**
 * THE LAYOUT CHOICE OF THIS DEVICE, kept in browser storage: whether a ferret's agenda is docked beside its chat
 * on a wide screen. It is not an answer or daemon state: it tells the ferret nothing and changes no item.
 *
 * Storage is an ordinary browser condition that may be absent or refuse writes (a private window, blocked
 * site data): every read and write is guarded, and the choice still holds for the rest of the tab.
 */

import { useCallback, useState } from 'react';

export interface CollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether a value can be read and written as storage. */
const isCollapseStorage = (value: CollapseStorage | undefined): value is CollapseStorage =>
  typeof value?.getItem === 'function' && typeof value?.setItem === 'function';

const browserCollapseStorage = (): CollapseStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: CollapseStorage }).localStorage;
    return isCollapseStorage(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
};

const readFlag = (storage: CollapseStorage | undefined, key: string): boolean => {
  try {
    return storage?.getItem(key) === '1';
  } catch {
    return false;
  }
};

const writeFlag = (storage: CollapseStorage | undefined, key: string, on: boolean): void => {
  if (storage === undefined) return;
  try {
    storage.setItem(key, on ? '1' : '0');
  } catch {
    // The choice still holds for this tab.
  }
};

const useStoredFlag = (key: string, storage: CollapseStorage | undefined): readonly [boolean, () => void] => {
  const [on, setOn] = useState(() => readFlag(storage, key));
  const toggle = useCallback(() => {
    setOn(!on);
    writeFlag(storage, key, !on);
  }, [on, key, storage]);
  return [on, toggle];
};

/** Whether the agenda is docked beside the chat (a wide screen with a mouse). */
const AGENDA_DOCK_KEY = 'fy-agenda-dock-v1';

export const useAgendaDock = (
  storage: CollapseStorage | undefined = browserCollapseStorage(),
): readonly [boolean, () => void] => useStoredFlag(AGENDA_DOCK_KEY, storage);
