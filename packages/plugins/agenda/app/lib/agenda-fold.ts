/**
 * WHETHER A FOLDED PART OF AN ITEM IS OPEN, remembered per item per device (docs/agenda.md § The item view): the
 * detailed context and the activity log start closed, and stay as the owner left them on this device. Browser storage
 * is a convenience only — a private window, blocked site data or a storage that throws reads as "closed", and a write
 * that fails is dropped — so the view draws the same without it.
 */

const PREFIX = 'fy.agenda.fold.v1';

/** The storage key of one part of one item: `item` already names the machine and the conversation it is in. */
const foldStorageKey = (item: string, part: string): string => `${PREFIX}:${item}:${part}`;

type FoldStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storage = (): FoldStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Whether the owner left this part open on this device. Closed when nothing was kept or nothing can be read. */
export const readFold = (item: string, part: string, store: FoldStorage | null = storage()): boolean => {
  try {
    return store?.getItem(foldStorageKey(item, part)) === 'open';
  } catch {
    return false;
  }
};

/** Keeps the part open or closed on this device; closed is the default, so closing forgets the key. */
export const writeFold = (item: string, part: string, open: boolean, store: FoldStorage | null = storage()): void => {
  try {
    if (open) store?.setItem(foldStorageKey(item, part), 'open');
    else store?.removeItem(foldStorageKey(item, part));
  } catch {
    // A storage that refuses the write: the part still opens for now, it is only not remembered.
  }
};

const TAB_PREFIX = 'fy.agenda.tab.v1';

/** The tab the owner left this item on, on this device (its id), or `null` when none was kept or none can be read. */
export const readTab = (item: string, store: FoldStorage | null = storage()): string | null => {
  try {
    return store?.getItem(`${TAB_PREFIX}:${item}`) ?? null;
  } catch {
    return null;
  }
};

/** Keeps the tab the owner is on; the main tab is the default, so going back to it forgets the key. */
export const writeTab = (item: string, tab: string, main: boolean, store: FoldStorage | null = storage()): void => {
  try {
    if (main) store?.removeItem(`${TAB_PREFIX}:${item}`);
    else store?.setItem(`${TAB_PREFIX}:${item}`, tab);
  } catch {
    // A storage that refuses the write: the tab still shows for now, it is only not remembered.
  }
};
