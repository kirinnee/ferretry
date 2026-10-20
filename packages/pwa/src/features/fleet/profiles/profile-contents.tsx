/**
 * A profile's contents (R5): ONE ordered list where a later item overrides an earlier one, each row
 * marked "overrides ‹X› · ‹key›" where it does; and the Resolved view, every final value with the item
 * it came from and the values it overrode struck through.
 *
 * Reordering works three ways, and none needs a pointer: drag a row (desktop), or its ↑ / ↓ buttons,
 * which keep focus on the row that moved. ✕ takes an item out.
 */

import type { FleetResolvedEntry } from '@ferretry/protocol';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import type { DragEvent } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { Button } from '../../../shell/primitives.tsx';
import { type CatalogHarness, HARNESS_NAMES } from '../components/component-model.ts';
import { ITEM_ACTIONS, ITEM_ROW, ItemBody, ItemChips, ItemLine, ItemName, KindTag } from './profile-library.tsx';
import { itemName, type OverrideChip, type ProfileItem, RESOLVED_FIELD_WORDS } from './profile-model.ts';

export interface ContentsListProps {
  readonly items: readonly ProfileItem[];
  readonly chips: ReadonlyMap<string, readonly OverrideChip[]>;
  /** Where a drop would land: before this index, or `items.length` for the end. */
  readonly dropBefore: number | null;
  readonly onMove: (index: number, by: -1 | 1) => void;
  readonly onRemove: (index: number) => void;
  readonly onDragStart: (event: DragEvent<HTMLLIElement>, index: number) => void;
  readonly onDragEnd: () => void;
  /** Something is being dragged over the list, before `index`. */
  readonly onDragOver: (event: DragEvent<HTMLElement>, index: number) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function ContentsList(props: ContentsListProps) {
  const { items, chips, dropBefore, onMove, onRemove, onDragStart, onDragEnd, onDragOver, onDrop } = props;
  return (
    <ol
      className="m-0 flex min-h-[6rem] min-w-0 list-none flex-col gap-1 px-panel py-2 md:pb-8"
      aria-label="Contents, later items override earlier ones"
      data-profile-contents=""
      onDragOver={event => onDragOver(event, items.length)}
      onDrop={onDrop}
    >
      {items.length === 0 ? (
        <li className="px-2 py-4 text-center text-cell text-muted" data-profile-contents-empty="">
          <span className="md:hidden">Tap Add to put components in.</span>
          <span className="hidden md:inline">Drop components here, or use Add in the library.</span>
        </li>
      ) : null}
      {items.map((item, index) => (
        <li
          key={item.reference}
          className={cn(
            ITEM_ROW,
            'md:cursor-grab',
            dropBefore === index && 'shadow-[0_calc(-1*var(--border-width-heavy))_0_0_var(--accent)]',
          )}
          draggable
          onDragStart={event => onDragStart(event, index)}
          onDragEnd={onDragEnd}
          onDragOver={event => {
            event.stopPropagation();
            onDragOver(event, index);
          }}
          data-profile-item={item.reference}
        >
          <ItemBody>
            <ItemLine>
              <span className="w-5 shrink-0 text-right font-mono text-meta text-muted">{index + 1}</span>
              <GripVertical size={14} aria-hidden="true" className="hidden shrink-0 text-muted md:inline" />
              <KindTag kind={item.kind} />
              <ItemName name={item.name} />
            </ItemLine>
            <ItemChips scope={item.scope}>
              {(chips.get(item.reference) ?? []).map(chip => (
                <span
                  key={`${chip.over}\n${chip.key}`}
                  className="kt-badge h-auto max-w-full !whitespace-normal break-words !normal-case"
                  data-tone="warn"
                  title={`${item.name} sets ${chip.key} later, so its value wins over ${itemName(chip.over)}’s`}
                  data-override-chip={chip.over}
                >
                  <span>
                    overrides {itemName(chip.over)} · <span className="font-mono">{chip.key}</span>
                  </span>
                </span>
              ))}
            </ItemChips>
          </ItemBody>
          <span className={ITEM_ACTIONS}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Move ${item.name} up`}
              disabled={index === 0}
              data-item-move="up"
              onClick={() => onMove(index, -1)}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Move ${item.name} down`}
              disabled={index === items.length - 1}
              data-item-move="down"
              onClick={() => onMove(index, 1)}
            >
              <ArrowDown size={14} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Remove ${item.name}`}
              data-item-remove=""
              onClick={() => onRemove(index)}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </span>
        </li>
      ))}
      {dropBefore !== null && dropBefore === items.length && items.length > 0 ? (
        <li aria-hidden="true" className="h-0.5 rounded-control bg-accent" data-drop-end="" />
      ) : null}
    </ol>
  );
}

const keyWords = (entry: FleetResolvedEntry): string =>
  entry.field === 'settings' || entry.field === 'env' || entry.field === 'model'
    ? entry.key
    : `${RESOLVED_FIELD_WORDS[entry.field]} · ${entry.key}`;

/** One Resolved row: stacked on a phone, three columns from `md` up. */
const RESOLVED_COLUMNS = 'min-w-0 gap-x-3 gap-y-0.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.8fr)]';

/** Each row with a key unique among them: a flag can repeat, so a repeat counts itself. */
function keyedRows(rows: readonly FleetResolvedEntry[]): readonly { entry: FleetResolvedEntry; id: string }[] {
  const seen = new Map<string, number>();
  return rows.map(entry => {
    const base = `${entry.field}\n${entry.key}\n${entry.value}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { entry, id: `${base}\n${count}` };
  });
}

/** The Resolved view: what the runtime finally gets, value by value, and from which item. */
export function ResolvedTable({
  entries,
  harnesses,
  harness,
  onHarness,
}: {
  entries: readonly FleetResolvedEntry[] | undefined;
  harnesses: readonly CatalogHarness[];
  harness: CatalogHarness;
  onHarness: (next: CatalogHarness) => void;
}) {
  if (entries === undefined)
    return (
      <p className="m-0 p-panel text-cell text-muted" data-resolved="unavailable">
        This machine’s Ferretry is too old to show the resolved values. Update it to see them.
      </p>
    );
  const rows = entries.filter(entry => entry.harness === harness);
  return (
    <div className="flex min-w-0 flex-col gap-2 px-panel py-2" data-resolved={harness}>
      {harnesses.length < 2 ? null : (
        <fieldset className="m-0 flex border-0 p-0" aria-label="Resolved for">
          {harnesses.map(each => (
            <button
              key={each}
              type="button"
              aria-pressed={each === harness}
              className={cn('kt-btn kt-btn--sm', each === harness ? 'text-accent' : 'text-muted')}
              data-variant={each === harness ? undefined : 'ghost'}
              data-resolved-harness={each}
              onClick={() => onHarness(each)}
            >
              {HARNESS_NAMES[each]}
            </button>
          ))}
        </fieldset>
      )}
      {rows.length === 0 ? (
        <p className="m-0 py-3 text-cell text-muted">Nothing resolves yet: add something to the profile.</p>
      ) : (
        <div className="flex min-w-0 flex-col">
          <div
            aria-hidden="true"
            className={cn(RESOLVED_COLUMNS, 'hidden border-b border-border py-1 text-meta text-muted md:grid')}
          >
            <span>Key</span>
            <span>Value</span>
            <span>From</span>
          </div>
          <ul className="m-0 flex min-w-0 list-none flex-col p-0" aria-label={`Resolved for ${HARNESS_NAMES[harness]}`}>
            {keyedRows(rows).map(({ entry, id }) => (
              <li
                key={id}
                className={cn(RESOLVED_COLUMNS, 'grid border-b border-border py-1.5')}
                data-resolved-row={entry.key}
              >
                <span className="font-mono text-meta text-muted [overflow-wrap:anywhere] md:text-cell md:text-fg">
                  {keyWords(entry)}
                </span>
                <span className="flex min-w-0 flex-col font-mono text-cell [overflow-wrap:anywhere]">
                  <span className={entry.hidden ? 'text-muted' : 'text-fg'}>{entry.value}</span>
                  {entry.overridden.map(beaten => (
                    <s key={`${beaten.from}\n${beaten.value}`} className="text-muted" data-resolved-overridden="">
                      <span className="sr-only">overrode </span>
                      {beaten.value}
                    </s>
                  ))}
                </span>
                <span className="flex min-w-0 flex-col text-cell [overflow-wrap:anywhere]">
                  <span className="text-fg">
                    <span className="text-muted md:hidden">from </span>
                    {itemName(entry.from)}
                  </span>
                  {entry.overridden.map(beaten => (
                    <s key={`${beaten.from}\n${beaten.value}`} className="text-muted">
                      {itemName(beaten.from)}
                    </s>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
