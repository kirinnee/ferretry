/**
 * THE OPEN ITEM'S ⋯ MENU (docs/agenda.md § The item view, "One menu for the quiet controls"). Every control the owner
 * reaches for only now and then — the version picker, Changes, Snooze, Merge with…, Not needed, a host's quiet tools
 * and a gate item's summary — sits behind ONE ⋯ button in the head, so on a phone the title, the chips and the premise
 * get the screen. On a phone (the drawer layout, under 768px) the menu is the app's one bottom sheet; wider, it is a
 * popover under ⋯. Esc, a tap outside and the sheet's own swipe close it; every choice that does something closes it.
 *
 * This draws only the shell and its rows: what is in it is the item view's (`agenda-item-view.tsx`).
 */

import type { AgendaItem } from '@ferretry/core-asks/contract';
import { Ellipsis } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type PopoverPlace, placePopover, useLayoutMode } from '../../shell.ts';
import { revisionStamp, shortAgo, versionCount } from '../../lib/agenda-revisions.ts';
import { snoozePicks } from '../../lib/agenda-snooze.ts';
import { BottomSheet } from '../../shell.ts';
import { CustomSnoozeForm } from './agenda-snooze-menu.tsx';

const FOCUSABLE = 'button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href]';

export interface AgendaItemMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What the menu is called to a screen reader and on the sheet: "Item options". */
  readonly label?: string;
  readonly children: ReactNode;
}

export function AgendaItemMenu({ open, onOpenChange, label = 'Item options', children }: AgendaItemMenuProps) {
  const sheet = useLayoutMode() === 'drawer';
  const menuId = useId();
  const titleId = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  // The popover: focus its first control, and a press anywhere outside closes it. The popover is drawn on the page body
  // (below), so "outside" is outside the ⋯ button's wrapper AND outside the popover itself. (The sheet owns its own
  // focus and scrim.)
  useEffect(() => {
    if (!open || sheet) return undefined;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onPointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (root.current?.contains(target) === true || panel.current?.contains(target) === true) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open, sheet, onOpenChange]);

  // WHERE THE POPOVER SITS. It is fixed on the page body, placed from ⋯'s box and its own measured size: under ⋯ with
  // its right edge on ⋯'s, flipped above when the room below is short, and always inside the window. It follows ⋯
  // through a scroll of whatever holds the item and through a resize. Before the first measure it is hidden, so it
  // never flashes at the wrong place.
  const [place, setPlace] = useState<PopoverPlace | null>(null);
  // The page body this menu's wrapper sits in, once it is mounted in a real document: where the popover is drawn. A
  // renderer with no document (a test renderer's instances have no owner document) draws it where it is.
  const [pageBody, setPageBody] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPageBody(root.current?.ownerDocument?.body ?? null), []);
  useLayoutEffect(() => {
    if (!open || sheet) {
      setPlace(null);
      return undefined;
    }
    const measure = (): void => {
      const anchor = trigger.current?.getBoundingClientRect();
      const box = panel.current?.getBoundingClientRect();
      if (anchor === undefined || box === undefined || panel.current === null) return;
      // The menu's own height, not the capped one it was last given: a flip must not depend on its own answer.
      const size = { width: box.width, height: Math.max(box.height, panel.current.scrollHeight) };
      const next = placePopover(anchor, size, { width: window.innerWidth, height: window.innerHeight });
      setPlace(current =>
        current?.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [open, sheet]);

  // A choice that closes the menu (a version picked, Changes, Merge with…) takes the focused control away with it: put
  // focus back on ⋯ so a keyboard is still in the item. A press outside keeps its own target, which already has focus.
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) trigger.current?.focus();
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open || sheet || event.key !== 'Escape') return;
    // Esc closes the menu, not the item it sits on.
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
    trigger.current?.focus();
  };

  const body = (
    <div className="fy-item-menu__body" data-agenda-menu-body="">
      {children}
    </div>
  );

  const popover = (() => {
    const drawn = (
      <div
        aria-label={label}
        className="fy-item-menu__popover"
        data-agenda-menu="popover"
        id={menuId}
        ref={panel}
        role="dialog"
        style={
          place === null ? { visibility: 'hidden' } : { left: place.left, top: place.top, maxHeight: place.maxHeight }
        }
      >
        {body}
      </div>
    );
    return pageBody === null ? drawn : createPortal(drawn, pageBody);
  })();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc is the popover's own key; the controls inside are real buttons
    <div className="fy-item-menu" onKeyDown={onKeyDown} ref={root}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="fy-item-view__step fy-item-view__step--tight fy-item-menu__toggle"
        data-agenda-menu-toggle=""
        onClick={() => onOpenChange(!open)}
        ref={trigger}
        title="More"
        type="button"
      >
        <Ellipsis aria-hidden="true" size={18} />
      </button>
      {sheet
        ? typeof document === 'undefined'
          ? null
          : createPortal(
              <BottomSheet
                closeLabel="Close the item options"
                id={menuId}
                labelledBy={titleId}
                onClose={() => onOpenChange(false)}
                open={open}
                zIndexClass="z-50"
              >
                <div className="fy-item-menu__sheet" data-agenda-menu="sheet">
                  <h2 className="fy-item-menu__title" id={titleId}>
                    {label}
                  </h2>
                  {body}
                </div>
              </BottomSheet>,
              document.body,
            )
        : open
          ? // On the page body, `position: fixed`: the card's `overflow` cannot clip it and no neighbouring column can
            // paint over it (the nav, the ferret list), whatever width the column it opened from has.
            popover
          : null}
    </div>
  );
}

/** One group of the menu: a quiet label over its controls. */
export function MenuGroup({
  title,
  hook,
  children,
}: {
  readonly title: string;
  /** The group's test and harness handle: `data-agenda-menu-group`. */
  readonly hook: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="fy-item-menu__group" data-agenda-menu-group={hook}>
      <h3 className="fy-item-menu__label" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** "Edit 2 of 3 · 3m ago": a native picker, so it is a keyboard's and a screen reader's as much as a finger's. */
export function VersionPicker({
  item,
  shown,
  now,
  onShow,
  asEdits,
}: {
  /** Beside the diff control's stored versions (v1, v2…) these are the item's edits, so they are called edits. */
  readonly asEdits: boolean;
  readonly item: AgendaItem;
  readonly shown: number;
  readonly now: number;
  readonly onShow: (version: number) => void;
}) {
  const count = versionCount(item);
  const atOf = (version: number): string =>
    version === 1 ? item.waitingSince : (item.revisions?.[version - 2]?.at ?? item.waitingSince);
  const when = (version: number): string =>
    version === count ? shortAgo(atOf(version), now) : revisionStamp(atOf(version), now);
  return (
    <select
      aria-label={asEdits ? 'Edit' : 'Version'}
      className="fy-item-menu__version"
      data-agenda-version-picker=""
      onChange={event => onShow(Number(event.currentTarget.value))}
      value={shown}
    >
      {Array.from({ length: count }, (_, at) => count - at).map(version => (
        <option key={version} value={version}>
          {`${asEdits ? 'Edit ' : 'v'}${String(version)} of ${String(count)}${when(version) === '' ? '' : ` · ${when(version)}`}`}
        </option>
      ))}
    </select>
  );
}

/**
 * Snooze, as the menu's row of choices: the same list the clock menu and the swipe-down compass draw (`snoozePicks`),
 * with Custom… opening the date-and-time field in place.
 */
export function SnoozeChoices({
  now,
  disabled,
  onSnooze,
}: {
  readonly now: number;
  readonly disabled: boolean;
  readonly onSnooze: (until: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  return (
    <>
      <div className="fy-item-menu__chips">
        {snoozePicks(now).map(pick =>
          pick.until === null ? (
            <button
              aria-expanded={custom}
              className="fy-item-menu__chip"
              data-agenda-menu-snooze={pick.id}
              disabled={disabled}
              key={pick.id}
              onClick={() => setCustom(shown => !shown)}
              type="button"
            >
              {pick.label}
            </button>
          ) : (
            <button
              className="fy-item-menu__chip"
              data-agenda-menu-snooze={pick.id}
              disabled={disabled}
              key={pick.id}
              onClick={() => onSnooze(pick.until as string)}
              type="button"
            >
              {pick.label}
            </button>
          ),
        )}
      </div>
      {custom ? <CustomSnoozeForm now={now} onSnooze={onSnooze} /> : null}
    </>
  );
}
