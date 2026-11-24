/**
 * THE PHONE FERRET PAGE'S ONE ROW OF CHIPS: Chat, Console, Processes, Terminals, Browser, Files…, then "+".
 *
 * v4's row (`phone-chip-row.tsx`) carried over: slim (a switch, not a destination), scrolling sideways with the active chip
 * kept in view, a real WAI-ARIA tablist (roving tabindex; arrows move focus AND selection, Home/End jump), and "+" after
 * the list as a plain menu button, because it is an action and not a tab. The words and the order are
 * `ferret-workspace-model.ts`'s; this draws them and knows no panel.
 *
 * THE PHONE'S ROW NEVER SHOWS HALF A LABEL (O11 R7). A sideways-scrolling row always ends in a chip cut by the edge, and the chips
 * past it (Browser, Files) were out of sight. So the chips that fit stay, whole, and the rest sit behind a "More tabs" button; the
 * tab on show always takes a place in the row (`fitTabs`). The widths come from a hidden twin of the row that is measured, because
 * a label's width is only known once drawn.
 */

import { Ellipsis, Plus } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../ui/context-menu.tsx';
import { useInputModality } from '../ui/hooks/use-input-modality.ts';
import { cn } from '../ui/lib/class-names.ts';
import { fitTabs, type NewTabChoice, nextTab, type PhoneTab } from './ferret-workspace-model.ts';

/** The width a phone's icon button has (`w-11`), used for "More tabs" when "+" is not there to be measured. */
const ICON_BUTTON_PX = 44;

const CHIP_CLASS =
  'flex h-7 max-w-[14rem] shrink-0 max-md:h-11 items-center rounded-control px-3 text-cell font-medium leading-none transition-colors';
const ICON_BUTTON_CLASS =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg max-md:h-11 max-md:w-11';

interface RowFit {
  readonly room: number;
  readonly gap: number;
  readonly widths: ReadonlyMap<string, number>;
  readonly icon: number;
}
const UNMEASURED: RowFit = { room: 0, gap: 0, widths: new Map(), icon: ICON_BUTTON_PX };
const sameFit = (a: RowFit, b: RowFit): boolean =>
  a.room === b.room &&
  a.gap === b.gap &&
  a.icon === b.icon &&
  a.widths.size === b.widths.size &&
  [...a.widths].every(([key, width]) => b.widths.get(key) === width);

export const phoneChipId = (rowId: string, key: string): string => `${rowId}-chip-${key}`;

export interface PhoneTabRowProps {
  /** Instance id for the chip ids — two retained pages must not collide. */
  readonly rowId: string;
  readonly tabs: readonly PhoneTab[];
  readonly active: string;
  readonly onSelect: (key: string) => void;
  /** What "+" opens. None: no "+". */
  readonly choices: readonly NewTabChoice[];
  readonly onChoose: (choice: NewTabChoice) => void;
  /** What the row is called for a screen reader (default: the phone's "Ferret tabs"). */
  readonly label?: string;
  /** Drawn at the row's far end (the wide column's hide button). */
  readonly trailing?: ReactNode;
}

export function PhoneTabRow({
  rowId,
  tabs,
  active,
  onSelect,
  choices,
  onChoose,
  label = 'Ferret tabs',
  trailing,
}: PhoneTabRowProps) {
  const row = useRef<HTMLDivElement | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const plus = useRef<HTMLButtonElement | null>(null);
  const more = useRef<HTMLButtonElement | null>(null);
  const outer = useRef<HTMLDivElement | null>(null);
  const ruler = useRef<HTMLDivElement | null>(null);
  const refocus = useRef<string | null>(null);
  const { touchAffected } = useInputModality();
  const [anchor, setAnchor] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const phone = trailing === undefined;
  const [measured, setMeasured] = useState<RowFit>(UNMEASURED);

  // Measure the row and its hidden twin: the width the chips have to share, and each one's own width.
  useLayoutEffect(() => {
    const element = outer.current;
    const twin = ruler.current;
    if (!phone || tabs.length === 0 || element === null || twin === null) return;
    const read = (): void => {
      const style = getComputedStyle(element);
      const inner = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const gap = parseFloat(style.columnGap) || 0;
      const icon = plus.current?.offsetWidth || ICON_BUTTON_PX;
      const widths = new Map<string, number>();
      for (const chip of twin.querySelectorAll<HTMLElement>('[data-measure]'))
        widths.set(chip.dataset.measure ?? '', chip.offsetWidth);
      const taken = (choices.length > 0 ? icon + gap : 0) + icon + gap;
      const next: RowFit = {
        room: inner > 0 ? inner - taken : 0,
        gap: parseFloat(getComputedStyle(twin).columnGap) || 0,
        widths,
        icon,
      };
      setMeasured(previous => (sameFit(previous, next) ? previous : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [phone, tabs.length, choices.length]);

  const { shown, hidden } = phone
    ? fitTabs(tabs, measured.widths, active, { room: measured.room, gap: measured.gap, more: measured.icon })
    : { shown: tabs, hidden: [] as readonly PhoneTab[] };

  // Keep the active chip in view whenever it changes (centred when the row scrolls).
  useLayoutEffect(() => {
    const element = row.current;
    const chip = chips.current.get(active);
    if (element === null || chip === undefined) return;
    // Measured against the row itself: `offsetLeft` is from the nearest positioned ancestor, which beside the chat is the page.
    const within = chip.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft;
    const left = within - (element.clientWidth - chip.offsetWidth) / 2;
    element.scrollTo?.({ left: Math.max(0, left) });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = nextTab(tabs, active, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    // A tab that was behind "More" is drawn only once it is the one on show: focus follows it after that render.
    if (chips.current.has(next)) chips.current.get(next)?.focus();
    else refocus.current = next;
  };
  useLayoutEffect(() => {
    if (refocus.current === null) return;
    chips.current.get(refocus.current)?.focus();
    refocus.current = null;
  });

  const items: readonly ContextMenuItem[] = choices.map(choice => ({
    key: choice.id,
    label: choice.label,
    onSelect: () => onChoose(choice),
  }));
  const moreItems: readonly ContextMenuItem[] = hidden.map(tab => ({
    key: tab.key,
    label: tab.label,
    onSelect: () => onSelect(tab.key),
  }));

  return (
    <div
      className="relative flex min-w-0 shrink-0 items-center gap-sm border-b border-border-soft bg-surface px-3 py-0.5"
      data-phone-tab-row=""
      ref={outer}
    >
      {phone ? (
        <div
          aria-hidden="true"
          className="pointer-events-none invisible absolute left-0 top-0 flex w-max gap-0.5"
          ref={ruler}
        >
          {tabs.map(tab => (
            <div className={CHIP_CLASS} data-measure={tab.key} key={tab.key}>
              <span className="truncate">{tab.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div
        aria-label={label}
        aria-orientation="horizontal"
        className={cn(
          'flex min-w-0 items-center gap-0.5 rounded-control bg-surface-2',
          // The phone's row is one line that scrolls sideways. Beside the chat the row is narrow and holds more tabs than
          // fit: they wrap onto a second line, so none is cut by the edge or hides behind a fade.
          trailing === undefined
            ? 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
            : 'flex-wrap px-2 py-0.5',
        )}
        ref={row}
        role="tablist"
      >
        {shown.map(tab => (
          <button
            aria-selected={tab.key === active}
            className={cn(
              CHIP_CLASS,
              tab.key === active
                ? 'bg-surface text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]'
                : 'text-muted hover:text-fg',
            )}
            data-phone-chip={tab.key}
            id={phoneChipId(rowId, tab.key)}
            key={tab.key}
            onClick={() => onSelect(tab.key)}
            onKeyDown={onKeyDown}
            ref={element => {
              if (element === null) chips.current.delete(tab.key);
              else chips.current.set(tab.key, element);
            }}
            role="tab"
            tabIndex={tab.key === active ? 0 : -1}
            title={tab.label}
            type="button"
          >
            <span className="truncate">{tab.label}</span>
          </button>
        ))}
      </div>
      {hidden.length > 0 ? (
        <button
          aria-expanded={moreAnchor !== null}
          aria-haspopup="menu"
          aria-label="More tabs"
          className={cn(ICON_BUTTON_CLASS, 'ml-auto')}
          data-phone-more=""
          onClick={() => {
            const box = more.current?.getBoundingClientRect();
            setMoreAnchor({ x: box?.right ?? 0, y: box?.bottom ?? 0 });
          }}
          ref={more}
          type="button"
        >
          <Ellipsis aria-hidden="true" size={16} />
        </button>
      ) : null}
      {items.length > 0 ? (
        <button
          aria-expanded={anchor !== null}
          aria-haspopup="menu"
          aria-label="New tab"
          className={cn(trailing === undefined && hidden.length === 0 ? 'ml-auto' : '', ICON_BUTTON_CLASS)}
          data-phone-new-tab=""
          onClick={() => {
            const box = plus.current?.getBoundingClientRect();
            setAnchor({ x: box?.right ?? 0, y: box?.bottom ?? 0 });
          }}
          ref={plus}
          type="button"
        >
          <Plus aria-hidden="true" size={16} />
        </button>
      ) : null}
      {trailing === undefined ? null : <div className="ml-auto flex shrink-0 items-center">{trailing}</div>}
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="New tab"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={plus}
      />
      <ContextMenu
        anchor={moreAnchor ?? { x: 0, y: 0 }}
        ariaLabel="More tabs"
        items={moreItems}
        onClose={() => setMoreAnchor(null)}
        open={moreAnchor !== null}
        touch={touchAffected}
        triggerRef={more}
      />
    </div>
  );
}
