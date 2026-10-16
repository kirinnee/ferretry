/**
 * THE PHONE'S ONE ROW OF TABS: Chat, Console, every workspace tab, then ＋.
 *
 * A phone has no splits, so every pane's tabs merge into this single row under
 * the header. It scrolls sideways and keeps the ACTIVE chip centred, so the tabs
 * either side of it are always visible and a swipe on the content never selects
 * a chip the reader cannot see. A chip an agent is driving carries an AGENT
 * badge, because typing into a tab someone else is steering is a collision.
 *
 * It is SLIM — about 32px in all — because it is a switch, not a destination (owner: "it's taking up
 * so much vertical space for a switch"). The chips are 28px tall rather than the 44px control floor;
 * each is still a wide target, and the whole strip under a thumb is one of them (`[data-phone-tab-row]`
 * in styles/index.css lifts the global floor for exactly this row).
 *
 * It is a real WAI-ARIA tablist: roving tabindex, arrow keys move focus AND
 * selection, Home/End jump. ＋ sits after the list as a plain menu button — it is
 * an action, not a tab.
 */

import { FileText, Globe, type LucideIcon, MessageSquare, Plus, SquareTerminal, Terminal } from 'lucide-react';
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import { useInputModality } from '../../../hooks/use-input-modality.ts';
import { cn } from '../../../lib/class-names.ts';
import { usePrefersReducedMotion } from '../../../shell/bottom-sheet.tsx';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../../../shell/context-menu.tsx';
import { centredScrollLeft, type PhoneTab, type PhoneTabKind } from './phone-tab.ts';

const KIND_ICON: Readonly<Record<PhoneTabKind, LucideIcon>> = {
  chat: MessageSquare,
  console: Terminal,
  terminal: SquareTerminal,
  browser: Globe,
  file: FileText,
};

export const phoneChipId = (rowId: string, tabId: string): string => `${rowId}-chip-${tabId}`;
export const phonePanelId = (rowId: string, tabId: string): string => `${rowId}-panel-${tabId}`;

/** WAI-ARIA tab keys over the chip order. No wrap: the row has two real ends. */
export const nextPhoneChip = (key: string, currentId: string, order: readonly PhoneTab[]): string | null => {
  const index = order.findIndex(tab => tab.id === currentId);
  if (index === -1) return null;
  const pick = (at: number): string | null => order[at]?.id ?? null;
  switch (key) {
    case 'ArrowRight':
      return pick(index + 1);
    case 'ArrowLeft':
      return pick(index - 1);
    case 'Home':
      return pick(0);
    case 'End':
      return pick(order.length - 1);
    default:
      return null;
  }
};

/** What ＋ can open. A callback left out is a choice this surface does not offer. */
export interface PhoneNewTabActions {
  readonly onNewTerminal?: () => void;
  readonly onNewBrowser?: () => void;
  readonly onOpenFile?: () => void;
}

export const phoneNewTabItems = ({
  onNewTerminal,
  onNewBrowser,
  onOpenFile,
}: PhoneNewTabActions): readonly ContextMenuItem[] => {
  const items: ContextMenuItem[] = [];
  if (onNewTerminal) items.push({ key: 'terminal', label: 'New terminal', onSelect: onNewTerminal });
  if (onNewBrowser) items.push({ key: 'browser', label: 'New browser', onSelect: onNewBrowser });
  if (onOpenFile) items.push({ key: 'file', label: 'Open file', onSelect: onOpenFile });
  return items;
};

export interface PhoneChipRowProps extends PhoneNewTabActions {
  /** Instance id for chip/panel ids — two retained workspaces must not collide. */
  readonly rowId: string;
  /** The full chip order, Chat and Console included (see `phoneTabOrder`). */
  readonly tabs: readonly PhoneTab[];
  readonly activeId: string;
  readonly onSelect: (tabId: string) => void;
}

function PhoneChip({
  rowId,
  tab,
  active,
  onSelect,
  onKeyDown,
  chipRef,
}: {
  readonly rowId: string;
  readonly tab: PhoneTab;
  readonly active: boolean;
  readonly onSelect: (tabId: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly chipRef: (element: HTMLButtonElement | null) => void;
}) {
  const Icon = KIND_ICON[tab.kind];
  const driver = tab.driver?.name;
  return (
    <button
      ref={chipRef}
      type="button"
      role="tab"
      id={phoneChipId(rowId, tab.id)}
      aria-selected={active}
      aria-controls={phonePanelId(rowId, tab.id)}
      tabIndex={active ? 0 : -1}
      title={driver ? `${tab.label} — ${driver} is driving` : tab.label}
      data-phone-chip={tab.id}
      onClick={() => onSelect(tab.id)}
      onKeyDown={onKeyDown}
      className={cn(
        'flex h-7 max-w-[14rem] shrink-0 items-center gap-xs rounded-control border px-control-x text-cell font-medium leading-none transition-colors',
        active
          ? 'border-accent-border bg-accent-soft text-fg'
          : 'border-border-soft bg-surface-2 text-muted hover:border-accent-border hover:text-fg',
      )}
    >
      <Icon size={14} aria-hidden="true" className={cn('shrink-0', active && 'text-accent')} />
      <span className="truncate">{tab.label}</span>
      {driver && (
        <span
          className="shrink-0 rounded-control border border-accent-border px-badge-x text-2xs font-semibold tracking-wide text-accent"
          data-phone-chip-agent=""
        >
          <span aria-hidden="true">AGENT</span>
          <span className="sr-only">, driven by {driver}</span>
        </span>
      )}
    </button>
  );
}

export function PhoneChipRow({ rowId, tabs, activeId, onSelect, ...actions }: PhoneChipRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const { touchAffected } = useInputModality();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const items = phoneNewTabItems(actions);
  const firstRender = useRef(true);

  // Centre the active chip whenever it changes. The first placement jumps —
  // animating the row into position on load reads as the app fidgeting.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const chip = chips.current.get(activeId);
    if (!row || !chip) return;
    const left = centredScrollLeft({
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      chipLeft: chip.offsetLeft,
      chipWidth: chip.offsetWidth,
    });
    const smooth = !reducedMotion && !firstRender.current;
    firstRender.current = false;
    row.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  }, [activeId, reducedMotion]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = nextPhoneChip(event.key, activeId, tabs);
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    chips.current.get(next)?.focus();
  };

  const openMenu = (): void => {
    const rect = (plusRef.current as HTMLButtonElement).getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom });
  };

  return (
    <div
      className="flex min-w-0 items-center gap-xs border-b border-border-soft bg-surface px-panel py-0.5"
      data-phone-tab-row=""
    >
      <div
        ref={rowRef}
        role="tablist"
        aria-label="Tabs"
        aria-orientation="horizontal"
        data-tab-swipe-ignore=""
        className="flex min-w-0 flex-1 items-center gap-xs overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map(tab => (
          <PhoneChip
            key={tab.id}
            rowId={rowId}
            tab={tab}
            active={tab.id === activeId}
            onSelect={onSelect}
            onKeyDown={onKeyDown}
            chipRef={element => {
              if (element) chips.current.set(tab.id, element);
              else chips.current.delete(tab.id);
            }}
          />
        ))}
      </div>
      {items.length > 0 && (
        <button
          ref={plusRef}
          type="button"
          aria-label="New tab"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={openMenu}
          className="flex h-7 w-9 shrink-0 items-center justify-center rounded-control border border-border-soft bg-surface-2 text-muted hover:border-accent-border hover:text-fg"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      )}
      <ContextMenu
        open={menu !== null}
        anchor={menu ?? { x: 0, y: 0 }}
        items={items}
        onClose={() => setMenu(null)}
        ariaLabel="New tab"
        triggerRef={plusRef}
        touch={touchAffected}
      />
    </div>
  );
}
