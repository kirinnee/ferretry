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
 * ONE RAIL CAN ALSO HOLD TWO LEVELS. `parentId` marks a row as belonging to the
 * one above it rather than sitting beside it, and it is drawn indented under a
 * corner rule. This is not a second navigation pattern: a child is an ordinary
 * row with the same role, the same keyboard order and the same selection, and
 * because both presentations are built from the same items the level exists in
 * the desktop tablist AND in the phone sheet rather than only where it was
 * styled.
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
  /** The second line, when the rail is showing one. */
  readonly detail?: string | undefined;
  /**
   * Drawn before the label, in the rail's own fixed slot; supply it already marked `aria-hidden`.
   *
   * ALL THE ROWS OR NONE OF THEM. Three of ten panels carrying one read as unfinished, which is
   * exactly what it was, and the rail cannot fix that for a caller — it can only guarantee that the
   * icons it IS given line up. See {@link ICON_SLOT_CLASS}.
   */
  readonly icon?: ReactNode;
  /**
   * The row this one BELONGS TO, when it is a level down rather than a sibling.
   *
   * THE RAIL IS WHERE NESTING HAS TO LIVE, because it is the one component both presentations are
   * built from: a level expressed in the desktop tablist and not in the phone sheet would be a
   * hierarchy that exists at one width and not the other. A child is drawn indented under its parent
   * with a corner rule, and it stays an ordinary row in every other respect — same roles, same
   * keyboard order, same selection.
   *
   * NAMING A PARENT THAT IS NOT IN `items` DRAWS NOTHING. A rail may be given a subset (a filtered
   * list, a caller that mounts some panels and not others), and an indent under a row that is not
   * there is a claim about a relation the reader cannot see. Ordering is the caller's: this component
   * does not move a child under its parent, it only draws the one that is already there.
   */
  readonly parentId?: T;
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
  /**
   * ONE HEIGHT RULE PER RAIL, chosen by whether the reader can see the panel from the row.
   *
   * `two-line`  Label and `detail`. What a PICKER needs: a sheet row is being chosen blind, so the
   *             description is the only thing distinguishing ten rows a reader cannot see behind it.
   * `single-line`  Label only. What a rail BESIDE its own panel needs. Ten two-line rows made the
   *             desktop rail 900px tall next to a 250px panel — the rail was the tallest thing on
   *             the page — and rows whose descriptions ran to two, three and four lines had no shared
   *             height at all. The description is not dropped: the panel it opens carries it as its
   *             own heading text, where the reader is looking once they arrive.
   *
   * The row's height is a FLOOR (`min-h-row`, the pointer-derived token), never a fixed height: a
   * theme that scales its type up, or a reader who scales text up, must be able to make a row taller.
   */
  readonly rows?: 'two-line' | 'single-line';
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

/**
 * ONE HEIGHT RULE AND ONE GAP, both from the scale.
 *
 * `min-h-row` is the pointer-derived floor — `max(--row-min-h-desktop, --target-floor)` — so a coarse
 * pointer gets its 44px without this component knowing what a pointer is, and a theme that runs denser
 * or looser moves with it. The literal `52px` it replaces was neither: it was above the touch floor on
 * a phone and below the content height of a two-line row anyway, so it never actually decided anything.
 *
 * Vertical space is `py-2` plus the row gap and NOTHING ELSE. Margins on the rows are what collapse and
 * double; `gap` on the flex parent cannot.
 */
const ROW_CLASS =
  'flex min-h-row w-full items-center gap-sm rounded-control border px-control-x py-2 text-left transition-colors focus-visible:outline-focus focus-visible:outline-offset-focus';
const SELECTED_ROW_CLASS = 'border-accent bg-accent-soft text-accent';
const IDLE_ROW_CLASS = 'border-transparent text-muted hover:border-border hover:bg-surface-2 hover:text-fg';
/** The gap between rows, once, so both presentations cannot drift apart. */
const RAIL_CLASS = 'flex flex-col gap-xs';

/**
 * THE FIXED ICON BOX — 16px, the app's HEADING optical size, drawn for EVERY row once ANY row has an icon.
 *
 * Without it each row indented its own label by whatever glyph it happened to carry, so a rail where
 * three of ten panels had icons had a left edge that alternated between two x positions down the whole
 * column. That ragged edge is what reads as "the icons were uneven" — the icons themselves were already
 * one size. A caller that supplies no icons at all gets no slot and no indent, so a plain rail is
 * unchanged.
 */
const ICON_SLOT_CLASS = 'flex w-4 shrink-0 items-center justify-center';

/**
 * A CHILD ROW IS INDENTED AND HOOKED, and nothing else about it changes.
 *
 * The indent alone reads as a stray margin on a rail whose rows are otherwise flush; the corner rule
 * is what says "this hangs off the row above" rather than "this row is oddly placed". It is drawn as
 * a bordered box rather than a glyph on purpose — the icon slot beside it is the row's own landmark,
 * and a second piece of art there would compete with it.
 */
const NESTED_ROW_CLASS = 'ml-md';
const NESTED_HOOK_CLASS = 'mr-xs h-3 w-2 shrink-0 rounded-bl-control border-b border-l border-border-strong';

export function ChoiceRail<T extends string>(props: ChoiceRailProps<T>) {
  const { items, activeId, onSelect, marker, truncate = false, rows = 'two-line' } = props;
  const refs = useRef(new Map<T, HTMLButtonElement>());
  // Read from the ITEMS rather than taken as a prop: whether this rail is a column of icons is a fact
  // about what it was given, and a caller that had to declare it as well could contradict itself.
  const hasIcons = items.some(item => item.icon !== undefined);

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

  /** A child only when the row it names is really on this rail — see {@link ChoiceRailItem.parentId}. */
  const nested = (item: ChoiceRailItem<T>): boolean =>
    item.parentId !== undefined && items.some(other => other.id === item.parentId);

  const row = (item: ChoiceRailItem<T>, selected: boolean): ReactNode => (
    <>
      {nested(item) ? <span aria-hidden="true" className={NESTED_HOOK_CLASS} /> : null}
      {hasIcons ? (
        <span className={ICON_SLOT_CLASS} aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className={cn('block text-ui font-semibold', truncate && 'truncate')}>{item.label}</span>
        {rows === 'single-line' || item.detail === undefined ? null : (
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
      <ul className={cn('m-0 list-none p-0', RAIL_CLASS)}>
        {items.map(item => {
          const selected = item.id === activeId;
          return (
            <li key={item.id}>
              <button
                type="button"
                {...markerFor(item.id)}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
                className={cn(
                  ROW_CLASS,
                  nested(item) && NESTED_ROW_CLASS,
                  selected ? SELECTED_ROW_CLASS : IDLE_ROW_CLASS,
                )}
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
    <div role="tablist" aria-orientation="vertical" aria-label={props.label} className={RAIL_CLASS}>
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
            className={cn(ROW_CLASS, nested(item) && NESTED_ROW_CLASS, selected ? SELECTED_ROW_CLASS : IDLE_ROW_CLASS)}
          >
            {row(item, selected)}
          </button>
        );
      })}
    </div>
  );
}
