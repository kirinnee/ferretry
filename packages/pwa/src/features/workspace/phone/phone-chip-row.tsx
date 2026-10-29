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

import {
  FileText,
  Globe,
  ListTree,
  type LucideIcon,
  MessageSquare,
  Plus,
  SquareTerminal,
  Terminal,
  X,
} from 'lucide-react';
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import { useInputModality } from '../../../hooks/use-input-modality.ts';
import { cn } from '../../../lib/class-names.ts';
import { usePrefersReducedMotion } from '../../../shell/bottom-sheet.tsx';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../../../shell/context-menu.tsx';
import { useRowContextGesture } from '../../../shell/row-context-gesture.ts';
import { centredScrollLeft, type PhoneTab, type PhoneTabKind } from './phone-tab.ts';

const KIND_ICON: Readonly<Record<PhoneTabKind, LucideIcon>> = {
  chat: MessageSquare,
  console: Terminal,
  processes: ListTree,
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
  /** Surfaces an agent opened whose tab was closed: ＋ brings them back. */
  readonly reopen?: readonly { readonly key: string; readonly label: string; readonly onSelect: () => void }[];
}

export const phoneNewTabItems = ({
  onNewTerminal,
  onNewBrowser,
  onOpenFile,
  reopen = [],
}: PhoneNewTabActions): readonly ContextMenuItem[] => {
  const items: ContextMenuItem[] = [];
  if (onNewTerminal) items.push({ key: 'terminal', label: 'New terminal', onSelect: onNewTerminal });
  if (onNewBrowser) items.push({ key: 'browser', label: 'New browser', onSelect: onNewBrowser });
  if (onOpenFile) items.push({ key: 'file', label: 'Open file', onSelect: onOpenFile });
  for (const [index, entry] of reopen.entries())
    items.push({ key: entry.key, label: entry.label, onSelect: entry.onSelect, separatorBefore: index === 0 });
  return items;
};

export interface PhoneChipRowProps extends PhoneNewTabActions, PhoneCloseTabActions {
  /** Instance id for chip/panel ids — two retained workspaces must not collide. */
  readonly rowId: string;
  /** The full chip order, Chat and Console included (see `phoneTabOrder`). */
  readonly tabs: readonly PhoneTab[];
  readonly activeId: string;
  readonly onSelect: (tabId: string) => void;
}

/** What a workspace chip can close. A callback left out is a choice this surface does not offer. */
export interface PhoneCloseTabActions {
  /** Closes the tab's VIEW. Present, every `closable` chip can be closed. */
  readonly onCloseTab?: (tabId: string) => void;
  /** Closes every closable tab but this one. */
  readonly onCloseOthers?: (tabId: string) => void;
  /** Ends a terminal tab's shell as well. Present, closing a terminal asks which of the two is meant. */
  readonly onEndTerminal?: (tabId: string) => void;
}

/**
 * The menu a chip opens: Close (or, for a terminal that can be ended, Close tab and End shell) and,
 * from a long-press, Close others. The two terminal choices say what happens to the shell, because a
 * tab and the process under it are different things and only one of them comes back.
 */
export const phoneCloseItems = (
  tab: PhoneTab,
  tabs: readonly PhoneTab[],
  { onCloseTab, onCloseOthers, onEndTerminal }: PhoneCloseTabActions,
  withOthers: boolean,
): readonly ContextMenuItem[] => {
  if (!tab.closable || onCloseTab === undefined) return [];
  const items: ContextMenuItem[] =
    tab.kind === 'terminal' && onEndTerminal !== undefined
      ? [
          {
            key: 'close-tab',
            label: 'Close tab',
            // Shorter than the desktop's "the shell keeps running": a phone menu is narrow, and the label must not truncate.
            detail: 'keeps running',
            onSelect: () => onCloseTab(tab.id),
          },
          {
            key: 'end-shell',
            label: 'End shell',
            detail: 'stops its process',
            danger: true,
            onSelect: () => onEndTerminal(tab.id),
          },
        ]
      : [{ key: 'close', label: 'Close', onSelect: () => onCloseTab(tab.id) }];
  const others = tabs.some(other => other.closable && other.id !== tab.id);
  if (withOthers && others && onCloseOthers !== undefined)
    items.push({
      key: 'close-others',
      label: 'Close others',
      separatorBefore: true,
      onSelect: () => onCloseOthers(tab.id),
    });
  return items;
};

/** A chip's request for its menu, at viewport coordinates, from ✕ or from a long-press. */
type OpenChipMenu = (tab: PhoneTab, at: MenuAnchor, trigger: HTMLElement, withOthers: boolean) => void;

function PhoneChip({
  rowId,
  tab,
  active,
  closable,
  onSelect,
  onKeyDown,
  onClose,
  onMenu,
  chipRef,
}: {
  readonly rowId: string;
  readonly tab: PhoneTab;
  readonly active: boolean;
  /** This chip can be closed here: it is a workspace tab and the host offers a close. */
  readonly closable: boolean;
  readonly onSelect: (tabId: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** ✕ or Delete: the chip's plain close, which asks first for a terminal. */
  readonly onClose: (tab: PhoneTab, trigger: HTMLElement) => void;
  readonly onMenu: OpenChipMenu;
  readonly chipRef: (element: HTMLButtonElement | null) => void;
}) {
  const Icon = KIND_ICON[tab.kind];
  const driver = tab.driver?.name;
  // A held finger (or a right-click) on a workspace chip opens Close / Close others. Chat and Console
  // are the agent's own tabs: there is nothing to close, so the browser keeps its own menu there.
  const gesture = useRowContextGesture<PhoneTab>(
    closable ? (subject, x, y, trigger) => onMenu(subject, { x, y }, trigger, true) : undefined,
    tab,
  );
  return (
    <button
      ref={chipRef}
      type="button"
      role="tab"
      id={phoneChipId(rowId, tab.id)}
      aria-selected={active}
      aria-controls={phonePanelId(rowId, tab.id)}
      aria-keyshortcuts={closable ? 'Delete' : undefined}
      tabIndex={active ? 0 : -1}
      title={driver ? `${tab.label} — ${driver} is driving` : tab.label}
      data-phone-chip={tab.id}
      data-asked={tab.asked === true}
      data-fresh={tab.fresh === true && tab.asked !== true}
      {...gesture}
      onClick={event => {
        // The ✕ is a part of the chip (a button inside role=tab is invalid), told apart by its marker.
        if ((event.target as HTMLElement).closest('[data-phone-chip-close]') !== null) {
          event.stopPropagation();
          onClose(tab, event.currentTarget);
          return;
        }
        onSelect(tab.id);
      }}
      onKeyDown={event => {
        if (closable && event.key === 'Delete') {
          event.preventDefault();
          onClose(tab, event.currentTarget);
          return;
        }
        onKeyDown(event);
      }}
      className={cn(
        'flex h-7 max-w-[14rem] shrink-0 items-center gap-xs rounded-control px-3 text-cell font-medium leading-none transition-colors',
        active ? 'bg-surface text-fg shadow-[inset_0_0_0_1px_var(--border-strong)]' : 'text-muted hover:text-fg',
        active && closable && 'pr-0',
      )}
    >
      <Icon size={14} aria-hidden="true" className={cn('shrink-0', active && 'text-accent')} />
      <span className="truncate">{tab.label}</span>
      {driver && tab.asked !== true && (
        <span
          className="shrink-0 rounded-control border border-accent-border px-badge-x text-2xs font-semibold tracking-wide text-accent"
          data-phone-chip-agent=""
        >
          <span aria-hidden="true">AGENT</span>
          <span className="sr-only">, driven by {driver}</span>
        </span>
      )}
      {/* The ✕ rides on the ACTIVE chip only: a row of ✕s would spend the row's width on a rare act, and
          a long-press closes any chip. Its target is the chip's height by 44px wide (phone-chip-close in
          styles/index.css), so the row stays the slim switch the owner asked for. */}
      {tab.asked === true && (
        <span
          className="shrink-0 rounded-control border border-accent-border px-badge-x text-2xs font-semibold tracking-wide text-accent"
          data-phone-chip-ask=""
        >
          <span aria-hidden="true">YOUR TURN</span>
          <span className="sr-only">, the agent is waiting for you here</span>
        </span>
      )}
      {tab.fresh === true && tab.asked !== true && (
        <span aria-hidden="true" className="fy-ws-new-dot" data-phone-chip-new="" />
      )}
      {active && closable && (
        <span data-phone-chip-close="" role="presentation" title={`Close ${tab.label}`} className="fy-phone-chip-close">
          <X size={12} aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

/** The one menu the row hosts: ＋'s, or a chip's close choices. */
interface OpenMenu {
  readonly kind: 'new' | 'close';
  readonly anchor: MenuAnchor;
  readonly items: readonly ContextMenuItem[];
  readonly label: string;
  readonly trigger: HTMLElement;
}

export function PhoneChipRow({ rowId, tabs, activeId, onSelect, ...actions }: PhoneChipRowProps) {
  const { onCloseTab, onEndTerminal } = actions;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const { touchAffected } = useInputModality();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
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

  const show = (next: OpenMenu): void => {
    triggerRef.current = next.trigger;
    setMenu(next);
  };

  const openNewMenu = (): void => {
    const plus = plusRef.current as HTMLButtonElement;
    const rect = plus.getBoundingClientRect();
    show({ kind: 'new', anchor: { x: rect.right, y: rect.bottom }, items, label: 'New tab', trigger: plus });
  };

  const openChipMenu: OpenChipMenu = (tab, anchor, trigger, withOthers) =>
    show({
      kind: 'close',
      anchor,
      items: phoneCloseItems(tab, tabs, actions, withOthers),
      label: `Close ${tab.label}`,
      trigger,
    });

  // ✕ closes at once, except a terminal that could also be ended: that asks, under the chip.
  const closeChip = (tab: PhoneTab, trigger: HTMLElement): void => {
    if (tab.kind !== 'terminal' || onEndTerminal === undefined) {
      onCloseTab?.(tab.id);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    openChipMenu(tab, { x: rect.left, y: rect.bottom }, trigger, false);
  };

  return (
    // ONE SEGMENTED ROW: the tabs sit on a single soft track, evenly padded and one height, and the
    // row's side padding is the conversation's own 12px gutter (`--chat-gutter-x`), so "Chat" starts on
    // the same line as the text under it. The track scrolls sideways when the tabs outgrow it; "+"
    // stays put at the right edge.
    <div
      className="flex min-w-0 items-center gap-sm border-b border-border-soft bg-surface px-3 py-0.5"
      data-phone-tab-row=""
    >
      <div
        ref={rowRef}
        role="tablist"
        aria-label="Tabs"
        aria-orientation="horizontal"
        data-tab-swipe-ignore=""
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-control bg-surface-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map(tab => (
          <PhoneChip
            key={tab.id}
            rowId={rowId}
            tab={tab}
            active={tab.id === activeId}
            closable={tab.closable === true && onCloseTab !== undefined}
            onSelect={onSelect}
            onKeyDown={onKeyDown}
            onClose={closeChip}
            onMenu={openChipMenu}
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
          aria-expanded={menu?.kind === 'new'}
          onClick={openNewMenu}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      )}
      <ContextMenu
        open={menu !== null}
        anchor={menu?.anchor ?? { x: 0, y: 0 }}
        items={menu?.items ?? []}
        onClose={() => setMenu(null)}
        ariaLabel={menu?.label ?? 'New tab'}
        triggerRef={triggerRef}
        touch={touchAffected}
      />
    </div>
  );
}
