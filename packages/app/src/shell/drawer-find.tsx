import { Search } from 'lucide-react';
import { type RefObject, useEffect } from 'react';
import { PALETTE_KEYSHORTCUTS, paletteShortcutLabel } from '../ui/palette-shortcut.ts';

/**
 * FIND, at the top of the left drawer: the one search field of the shell. It IS the existing command bar's entrance, not a
 * second search: pressing it (or Cmd/Ctrl+K from anywhere) puts focus here and opens the bar, and when the bar closes the
 * dialog's own restore-to-opener returns the caret to this field. In the slim rail it is the magnifier alone.
 */

export function DrawerFind({
  findRef,
  onOpen,
  rail,
}: {
  readonly findRef: RefObject<HTMLButtonElement | null>;
  readonly onOpen: () => void;
  readonly rail: boolean;
}) {
  return (
    <button
      ref={findRef}
      type="button"
      className={`fy-search fy-drawer__find${rail ? ' fy-drawer__find--rail' : ''}`}
      data-drawer-find=""
      aria-label={rail ? 'Find' : undefined}
      aria-keyshortcuts={PALETTE_KEYSHORTCUTS}
      title={rail ? `Find (${paletteShortcutLabel()})` : undefined}
      onClick={onOpen}
    >
      <Search aria-hidden="true" size={16} className="fy-search__icon" />
      {rail ? null : (
        <>
          <span className="fy-search__label">Find</span>
          <kbd className="mono">{paletteShortcutLabel()}</kbd>
        </>
      )}
    </button>
  );
}

/**
 * Cmd/Ctrl+K from anywhere: focus Find (when it is on screen: a phone's drawer is shut), then open the bar (or re-focus its
 * query when it is already open). The focus goes first so the bar's dialog remembers this field as its opener.
 */
export function useFindShortcut(findRef: RefObject<HTMLButtonElement | null>, open: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      findRef.current?.focus();
      open();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [findRef, open]);
}
