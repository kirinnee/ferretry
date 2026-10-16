/**
 * The library a profile is filled from (R5): every component and every other profile, searchable and
 * filterable by kind. On a desktop it sits beside the contents and its rows drag in — and a contents
 * row dragged back onto it is taken out. Every row also has an **Add** button, so nothing here needs
 * a pointer. On a phone the same list opens as a picker sheet from the contents' **Add** button.
 */

import { GripVertical } from 'lucide-react';
import { type DragEvent, useId } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../../lib/class-names.ts';
import { BottomSheet } from '../../../shell/bottom-sheet.tsx';
import { Button } from '../../../shell/primitives.tsx';
import { CatalogNote } from '../components/catalog-ui.tsx';
import { filterLibrary, ITEM_KIND_WORDS, ITEM_KINDS, type ItemKind, type ProfileItem } from './profile-model.ts';

export interface LibraryFilter {
  readonly query: string;
  readonly kind: ItemKind | 'all';
}

export const NO_FILTER: LibraryFilter = { query: '', kind: 'all' };

/** The small mono tag naming what an item is: MCP, Skills, Profile. */
export function KindTag({ kind }: { kind: ItemKind }) {
  return (
    <span
      className="shrink-0 rounded-control bg-surface-2 px-1 font-mono text-meta font-semibold uppercase text-muted"
      data-item-kind={kind}
    >
      {ITEM_KIND_WORDS[kind]}
    </span>
  );
}

function FilterBar({
  filter,
  onFilter,
  autoFocus = false,
}: {
  filter: LibraryFilter;
  onFilter: (next: LibraryFilter) => void;
  autoFocus?: boolean;
}) {
  const search = useId();
  const kind = useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label htmlFor={search} className="sr-only">
        Search components
      </label>
      <input
        id={search}
        type="search"
        className="kt-input min-w-0 flex-[1_1_8rem]"
        placeholder="Search…"
        value={filter.query}
        // biome-ignore lint/a11y/noAutofocus: the picker sheet opens to type into; Esc closes it
        autoFocus={autoFocus}
        data-library-search=""
        onChange={event => onFilter({ ...filter, query: event.currentTarget.value })}
      />
      <label htmlFor={kind} className="sr-only">
        Filter by kind
      </label>
      <select
        id={kind}
        className="kt-input w-auto"
        value={filter.kind}
        data-library-kind=""
        onChange={event => onFilter({ ...filter, kind: event.currentTarget.value as LibraryFilter['kind'] })}
      >
        <option value="all">All kinds</option>
        {ITEM_KINDS.map(each => (
          <option key={each} value={each}>
            {ITEM_KIND_WORDS[each]}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface LibraryProps {
  readonly items: readonly ProfileItem[];
  /** References already in the profile. */
  readonly contents: readonly string[];
  readonly profileLabel: string;
  readonly filter: LibraryFilter;
  readonly onFilter: (next: LibraryFilter) => void;
  readonly onAdd: (item: ProfileItem) => void;
}

function LibraryRows({
  items,
  contents,
  profileLabel,
  onAdd,
  onDragStart,
  onDragEnd,
  addedLabel,
}: Omit<LibraryProps, 'filter' | 'onFilter'> & {
  onDragStart?: (event: DragEvent<HTMLLIElement>, item: ProfileItem) => void;
  onDragEnd?: () => void;
  addedLabel: string;
}) {
  if (items.length === 0) return <li className="px-2 py-3 text-cell text-muted">No components match.</li>;
  return (
    <>
      {items.map(item => {
        const added = contents.includes(item.reference);
        return (
          <li
            key={item.reference}
            className={cn(
              'flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-border bg-surface px-2 py-1',
              onDragStart !== undefined && !added && 'cursor-grab',
            )}
            draggable={onDragStart !== undefined && !added}
            onDragStart={onDragStart === undefined ? undefined : event => onDragStart(event, item)}
            onDragEnd={onDragEnd}
            data-library-item={item.reference}
          >
            {onDragStart === undefined ? null : (
              <GripVertical size={14} aria-hidden="true" className="shrink-0 text-muted" />
            )}
            <KindTag kind={item.kind} />
            <span className="min-w-0 flex-1 break-words text-cell font-semibold text-fg">{item.name}</span>
            <ScopeTag scope={item.scope} />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={added}
              aria-label={added ? `${item.name} is in ${profileLabel}` : `Add ${item.name} to ${profileLabel}`}
              data-library-add={item.reference}
              onClick={() => onAdd(item)}
            >
              {added ? addedLabel : 'Add'}
            </Button>
          </li>
        );
      })}
    </>
  );
}

/** A scope chip, shown only for an item narrowed to one tool. */
export function ScopeTag({ scope }: { scope: ProfileItem['scope'] }) {
  if (scope === 'generic') return null;
  const words = { claude: 'Claude only', codex: 'Codex only', mixed: 'Mixed' } as const;
  return (
    <span className="kt-badge shrink-0" data-tone={scope === 'mixed' ? 'warn' : 'accent'} data-item-scope={scope}>
      {words[scope]}
    </span>
  );
}

/** The desktop library beside the contents: drag a row in, or drop a contents row here to remove it. */
export function LibraryPanel(
  props: LibraryProps & {
    readonly onDragStart: (event: DragEvent<HTMLLIElement>, item: ProfileItem) => void;
    readonly onDragEnd: () => void;
    /** A contents row is being dragged: this panel takes it as a removal. */
    readonly removing: boolean;
    readonly onRemoveDrop: () => void;
  },
) {
  const { items, filter, onFilter, removing, onRemoveDrop } = props;
  const shown = filterLibrary(items, filter.query, filter.kind);
  return (
    <section
      aria-label="Component library"
      className={cn(
        'kt-panel hidden min-w-0 flex-col md:flex',
        removing && 'outline-dashed outline-2 outline-offset-[-2px] outline-[var(--err)]',
      )}
      data-profile-library=""
      onDragOver={event => {
        if (!removing) return;
        event.preventDefault();
      }}
      onDrop={event => {
        if (!removing) return;
        event.preventDefault();
        onRemoveDrop();
      }}
    >
      <div className="flex min-w-0 flex-col gap-2 border-b border-border px-panel py-2">
        <h4 className="kt-label m-0">Library</h4>
        <FilterBar filter={filter} onFilter={onFilter} />
      </div>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-1 px-panel py-2 md:max-h-[32rem] md:overflow-y-auto">
        <LibraryRows {...props} items={shown} addedLabel="In profile" />
      </ul>
      <p className="m-0 px-panel pb-2 text-meta text-muted">
        Drag into the profile, or drag a profile item back here to remove it.
      </p>
    </section>
  );
}

/**
 * The phone's picker: the same library as a sheet, each row with Add. Portalled to the body, so the
 * sheet is laid out against the screen rather than inside the tab it was opened from.
 */
export function AddPicker(
  props: LibraryProps & {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly refusal: string | null;
  },
) {
  const { open, onClose, items, filter, onFilter, refusal, profileLabel } = props;
  const heading = useId();
  const shown = filterLibrary(items, filter.query, filter.kind);
  return createPortal(
    <BottomSheet
      id="profile-add-picker"
      open={open}
      onClose={onClose}
      labelledBy={heading}
      closeLabel="Close the picker"
      panelClassName="kt-details bg-surface"
      zIndexClass="z-50"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-panel pb-4" data-profile-picker="">
        <h2 id={heading} className="m-0 font-display text-title font-semibold text-fg">
          Add to {profileLabel}
        </h2>
        <FilterBar filter={filter} onFilter={onFilter} autoFocus />
        {refusal === null ? null : <CatalogNote tone="warn" role="alert" spot="picker-refused" title={refusal} />}
        <ul className="m-0 flex min-h-0 min-w-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
          <LibraryRows {...props} items={shown} addedLabel="Added" />
        </ul>
        <Button type="button" variant="primary" className="min-h-[44px]" data-picker-done="" onClick={onClose}>
          Done
        </Button>
      </div>
    </BottomSheet>,
    document.body,
  );
}
