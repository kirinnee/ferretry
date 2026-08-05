/**
 * ONE vertical choice rail, for every level of Settings navigation.
 *
 * Settings nests three of these — sections, then daemons, then the panels owned
 * by the selected daemon — and the first two had already been written twice as
 * the same list. One component is also the only place the nesting can be made
 * legible: rows that read identically at every level make a rail inside a rail
 * read as one list rather than as two strips competing for the same panel.
 *
 * TWO PRESENTATIONS, because the semantics genuinely differ and only one of
 * them is a tab pattern:
 *
 *   `navigation`  Ordinary buttons marked `aria-current="page"`. This is what a
 *                 sheet full of choices actually is; a sheet row given
 *                 `role="tab"` would claim a panel it does not control, and put
 *                 a second tablist on a page that has one panel to swap.
 *   `tabs`        Real WAI-ARIA tabs: one `role="tablist"` that declares
 *                 `aria-orientation="vertical"`, roving tabindex, stable row
 *                 ids so the panel can point back, and the keyboard policy
 *                 already ported in `sheet-tabs.tsx`. At most ONE rail per
 *                 screen may claim this, and it must be the rail whose panel is
 *                 beside it.
 *
 * The rail is deliberately presentational: it owns no selection state, reads no
 * store, and holds nothing between renders except the row elements it must be
 * able to focus. A caller that keys its own frame by daemon id therefore cannot
 * leak one daemon's selection into another through this component.
 */

import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../lib/class-names.ts';
import { nextDetailsTab } from './sheet-tabs.tsx';

export interface ChoiceRailItem<T extends string = string> {
  readonly id: T;
  readonly label: string;
  /** The second line. A row without one is a single-line row. */
  readonly detail?: string | undefined;
  /** Drawn before the label; supply it already marked `aria-hidden`. */
  readonly icon?: ReactNode;
}

interface ChoiceRailBaseProps<T extends string> {
  readonly items: readonly ChoiceRailItem<T>[];
  readonly activeId: T;
  readonly onSelect: (id: T) => void;
  /** The stable `data-*` attribute every row carries, e.g. `data-daemon-panel`. */
  readonly marker: string;
  /**
   * Clip both lines to one line each. A rail beside its own panel has the
   * height to let a description wrap, and clipping one is how a row stops being
   * discoverable; a rail of machine addresses has to clip, because an address is
   * long, opaque, and already repeated in full inside the panel.
   */
  readonly truncate?: boolean;
}

/**
 * The tab presentation carries three obligations a navigation rail does not, so
 * they are required by the type rather than defaulted: a tablist needs an
 * accessible name, and a tab needs both its own id (for the panel's
 * `aria-labelledby`) and the id of the panel it controls.
 */
type ChoiceRailProps<T extends string> =
  | (ChoiceRailBaseProps<T> & { readonly presentation?: 'navigation' })
  | (ChoiceRailBaseProps<T> & {
      readonly presentation: 'tabs';
      readonly label: string;
      readonly tabIdPrefix: string;
      readonly panelIdPrefix: string;
    });

const ROW_CLASS =
  'flex min-h-[52px] w-full items-center gap-2 rounded-control border px-control-x py-2 text-left transition-colors focus-visible:outline-focus focus-visible:outline-offset-focus';
const SELECTED_ROW_CLASS = 'border-accent bg-accent-soft text-accent';
const IDLE_ROW_CLASS = 'border-transparent text-muted hover:border-border hover:bg-surface-2 hover:text-fg';

export function ChoiceRail<T extends string>(props: ChoiceRailProps<T>) {
  const { items, activeId, onSelect, marker, truncate = false } = props;
  const refs = useRef(new Map<T, HTMLButtonElement>());

  // Focus follows selection, but ONLY when this rail already holds focus — an
  // unrelated re-render must never pull focus off the panel the reader is in.
  // This is `SheetTabs`' rule, kept identical so both tab strips behave alike.
  useEffect(() => {
    const focused = document.activeElement;
    for (const element of refs.current.values())
      if (element === focused) {
        refs.current.get(activeId)?.focus();
        break;
      }
  }, [activeId]);

  const markerFor = (id: T): Record<string, string> => ({ [marker]: id });

  const row = (item: ChoiceRailItem<T>, selected: boolean): ReactNode => (
    <>
      {item.icon}
      <span className="min-w-0 flex-1">
        <span className={cn('block text-ui font-semibold', truncate && 'truncate')}>{item.label}</span>
        {item.detail === undefined ? null : (
          <span className={cn('mt-0.5 block text-meta leading-tight text-faint', truncate && 'truncate')}>
            {item.detail}
          </span>
        )}
      </span>
      {selected ? <Check size={15} className="shrink-0" aria-hidden="true" /> : null}
    </>
  );

  if (props.presentation !== 'tabs')
    return (
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map(item => {
          const selected = item.id === activeId;
          return (
            <li key={item.id}>
              <button
                type="button"
                {...markerFor(item.id)}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
                className={cn(ROW_CLASS, selected ? SELECTED_ROW_CLASS : IDLE_ROW_CLASS)}
              >
                {row(item, selected)}
              </button>
            </li>
          );
        })}
      </ul>
    );

  const order = items.map(item => item.id);
  // Roving tabindex needs exactly one stop even when the active id names no row
  // — a dynamically supplied panel can disappear — so fall back to the first
  // row rather than leaving the whole rail unreachable from the keyboard.
  const focusStop = order.includes(activeId) ? activeId : order[0];

  return (
    <div role="tablist" aria-orientation="vertical" aria-label={props.label} className="flex flex-col gap-1">
      {items.map(item => {
        const selected = item.id === activeId;
        return (
          <button
            key={item.id}
            ref={element => {
              if (element) refs.current.set(item.id, element);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`${props.tabIdPrefix}${item.id}`}
            {...markerFor(item.id)}
            aria-selected={selected}
            aria-controls={`${props.panelIdPrefix}${item.id}`}
            tabIndex={item.id === focusStop ? 0 : -1}
            onClick={() => {
              if (!selected) onSelect(item.id);
            }}
            onKeyDown={event => {
              const next = nextDetailsTab(event.key, item.id, order);
              if (next === null) return;
              event.preventDefault();
              onSelect(next);
            }}
            className={cn(ROW_CLASS, selected ? SELECTED_ROW_CLASS : IDLE_ROW_CLASS)}
          >
            {row(item, selected)}
          </button>
        );
      })}
    </div>
  );
}
