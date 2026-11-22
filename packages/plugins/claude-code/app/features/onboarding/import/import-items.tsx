/**
 * "What comes over", on the page that sends it (C59 O5 items 8 and 9). Every item the scan found is ONE row: a checkbox
 * (ticked unless it was left out; only ticked items are brought) and a fold that opens to say what it becomes here. While the
 * import runs each row says what is happening to it in ONE line, and a single working bar shows it is busy: the page never
 * says "Importing…" itself (the footer's hold line is the one place that does).
 *
 * Pure parts first: {@link selectedItems} is what is brought, {@link itemStatus} is a row's one line. Nothing here
 * sends anything: the run page turns the same `skip` set into the request it already sends.
 */
import { Spinner } from '@ferretry/app/ui';
import {
  type FoundGroup,
  type FoundItem,
  IMPORT_KINDS,
  kindGroups,
  type ToolModel,
} from '@ferretry/plugin-runtimes/import-kit';
import { importItemId, type ImportItemId } from '@ferretry/plugin-runtimes/contract';
import { useId } from 'react';
import { HARNESS } from './segment.ts';

/** The ids that are brought: everything found that is not on the skip list. */
export const selectedItems = (ids: readonly ImportItemId[], skip: readonly ImportItemId[]): readonly ImportItemId[] =>
  ids.filter(id => !skip.includes(id));

export type ItemStatus = 'bringing' | 'left-out' | null;

/** A row's ONE status line: while the import runs a ticked row is being brought and an unticked one is left out; otherwise none. */
export const itemStatus = (on: boolean, working: boolean): ItemStatus =>
  !working ? null : on ? 'bringing' : 'left-out';

const STATUS_WORDS: Readonly<Record<Exclude<ItemStatus, null>, string>> = {
  bringing: 'Bringing in…',
  'left-out': 'Left out',
};

interface Row {
  readonly group: FoundGroup;
  readonly item: FoundItem;
}

/** Every item the scan found, once, in the order the kind pages show them. */
const rowsOf = (model: ToolModel): readonly Row[] => {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const kind of IMPORT_KINDS)
    for (const group of kindGroups(model, kind))
      for (const item of group.items) {
        const key = item.id ?? `${group.key}:${item.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ group, item });
      }
  return rows;
};

export interface ImportItemsProps {
  readonly model: ToolModel;
  /** What is left out: the page's own `skip` (the model set already follows its settings). */
  readonly skip: readonly ImportItemId[];
  readonly working: boolean;
  readonly onToggle: (id: ImportItemId, on: boolean) => void;
}

function ItemRow({
  row,
  skip,
  working,
  settingsLeft,
  onToggle,
}: {
  readonly row: Row;
  readonly skip: readonly ImportItemId[];
  readonly working: boolean;
  readonly settingsLeft: boolean;
  readonly onToggle: (id: ImportItemId, on: boolean) => void;
}) {
  const id = useId();
  const { item, group } = row;
  const on = item.id === null || !skip.includes(item.id);
  const followsSettings = group.key === 'modelSet' && settingsLeft;
  const status = itemStatus(on, working);
  return (
    <li className="cc-item" data-import-item={item.id ?? item.label} data-on={on}>
      <input
        id={id}
        type="checkbox"
        className="cc-item__box"
        aria-label={`Bring ${item.label}`}
        checked={on}
        disabled={working || item.id === null || followsSettings}
        onChange={event => {
          if (item.id !== null) onToggle(item.id, event.currentTarget.checked);
        }}
      />
      <details className="cc-item__fold">
        <summary className="cc-item__summary">{item.label}</summary>
        <div className="cc-item__more" data-import-item-more="">
          <p className="cc-item__line">{`Becomes: ${item.becomes}`}</p>
          {followsSettings ? (
            <p className="cc-item__line">The models come from your settings, which are left out.</p>
          ) : null}
          {group.locked === undefined ? null : (
            <p className="cc-item__line">
              {'Kept in the Vault: '}
              {group.locked.map((key, index) => (
                <span key={key}>
                  {index === 0 ? '' : ', '}
                  <code>{key}</code>
                </span>
              ))}
            </p>
          )}
        </div>
      </details>
      <span className="cc-item__status" data-import-item-status={status ?? 'none'}>
        {status === null ? null : (
          <>
            {status === 'bringing' ? <Spinner size={14} /> : null}
            {STATUS_WORDS[status]}
          </>
        )}
      </span>
    </li>
  );
}

/** The working bar: always drawn (so nothing moves when the import starts), only moving while it works. */
export const WorkingBar = ({ working }: { readonly working: boolean }) => (
  <div
    className="cc-working"
    role="progressbar"
    aria-label="Import progress"
    aria-busy={working}
    data-working={working}
    {...(working ? {} : { 'aria-valuenow': 0, 'aria-valuemin': 0, 'aria-valuemax': 100 })}
  >
    <span className="cc-working__bar" />
  </div>
);

export function ImportItems({ model, skip, working, onToggle }: ImportItemsProps) {
  const settingsLeft = skip.includes(importItemId(HARNESS, 'settings'));
  const rows = rowsOf(model);
  if (rows.length === 0) return null;
  return (
    <ul className="cc-items" data-import-items="" aria-label="What comes over">
      {rows.map(row => (
        <ItemRow
          key={row.item.id ?? `${row.group.key}:${row.item.label}`}
          row={row}
          skip={skip}
          working={working}
          settingsLeft={settingsLeft}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}
