/**
 * THE PHONE FERRET PAGE'S ONE ROW OF CHIPS: Chat, Console, Processes, Terminals, Browser, Files…, then "+".
 *
 * v4's row (`phone-chip-row.tsx`) carried over: slim (a switch, not a destination), scrolling sideways with the active chip
 * kept in view, a real WAI-ARIA tablist (roving tabindex; arrows move focus AND selection, Home/End jump), and "+" after
 * the list as a plain menu button, because it is an action and not a tab. The words and the order are
 * `ferret-workspace-model.ts`'s; this draws them and knows no panel.
 */

import { Plus } from 'lucide-react';
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '../ui/context-menu.tsx';
import { useInputModality } from '../ui/hooks/use-input-modality.ts';
import { cn } from '../ui/lib/class-names.ts';
import { type NewTabChoice, nextTab, type PhoneTab } from './ferret-workspace-model.ts';

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
}

export function PhoneTabRow({ rowId, tabs, active, onSelect, choices, onChoose }: PhoneTabRowProps) {
  const row = useRef<HTMLDivElement | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const plus = useRef<HTMLButtonElement | null>(null);
  const { touchAffected } = useInputModality();
  const [anchor, setAnchor] = useState<{ readonly x: number; readonly y: number } | null>(null);

  // Keep the active chip in view whenever it changes (centred when the row scrolls).
  useLayoutEffect(() => {
    const element = row.current;
    const chip = chips.current.get(active);
    if (element === null || chip === undefined) return;
    const left = chip.offsetLeft - (element.clientWidth - chip.offsetWidth) / 2;
    element.scrollTo?.({ left: Math.max(0, left) });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = nextTab(tabs, active, event.key);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    chips.current.get(next)?.focus();
  };

  const items: readonly ContextMenuItem[] = choices.map(choice => ({
    key: choice.id,
    label: choice.label,
    onSelect: () => onChoose(choice),
  }));

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-sm border-b border-border-soft bg-surface px-3 py-0.5"
      data-phone-tab-row=""
    >
      <div
        aria-label="Ferret tabs"
        aria-orientation="horizontal"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-control bg-surface-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        ref={row}
        role="tablist"
      >
        {tabs.map(tab => (
          <button
            aria-selected={tab.key === active}
            className={cn(
              'flex h-7 max-w-[14rem] shrink-0 items-center rounded-control px-3 text-cell font-medium leading-none transition-colors',
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
      {items.length > 0 ? (
        <button
          aria-expanded={anchor !== null}
          aria-haspopup="menu"
          aria-label="New tab"
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
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
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="New tab"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={plus}
      />
    </div>
  );
}
