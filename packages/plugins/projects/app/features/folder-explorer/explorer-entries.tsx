/**
 * THE ENTRIES OF ONE LISTING, as cards or as a list. One component, two shapes, because the same folders in the same
 * order are drawn either way and only the arrangement differs.
 *
 * ONE HIGHLIGHT. The highlighted folder is the keyboard's (`aria-activedescendant` on the listbox); a pointer never
 * draws a second one. The explorer picks folders, so it is only ever handed folders (the daemon also lists files).
 */
import { File, Folder, FolderGit2 } from 'lucide-react';
import { forwardRef, useEffect } from 'react';
import { cn } from '@ferretry/app/ui';
import type { FolderEntry } from '../../../contract/index.ts';
import type { ExplorerView } from './explorer-model.ts';

export interface ExplorerEntriesProps {
  readonly entries: readonly FolderEntry[];
  readonly view: ExplorerView;
  /** The listing's folders (files left out), so an index here is the keyboard's index. */
  readonly highlightedName: string | null;
  readonly idFor: (entry: FolderEntry) => string;
  readonly onOpen: (entry: FolderEntry) => void;
  readonly labelledBy: string;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

const when = (modifiedAt: string): string => {
  const at = Date.parse(modifiedAt);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
};

function EntryIcon({ entry, size }: { readonly entry: FolderEntry; readonly size: number }) {
  if (entry.kind === 'file') return <File className="shrink-0 text-faint" size={size} aria-hidden="true" />;
  if (entry.isRepo) return <FolderGit2 className="shrink-0 text-accent" size={size} aria-hidden="true" />;
  return <Folder className="shrink-0 text-muted" size={size} aria-hidden="true" />;
}

function RepoBadge() {
  return (
    <span
      className="rounded-control bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold text-accent"
      data-explorer-git-badge=""
    >
      git
    </span>
  );
}

export const ExplorerEntries = forwardRef<HTMLDivElement, ExplorerEntriesProps>(function ExplorerEntries(
  { entries, view, highlightedName, idFor, onOpen, labelledBy, onKeyDown },
  ref,
) {
  const card = view === 'card';
  const active = entries.find(entry => entry.kind === 'folder' && entry.name === highlightedName);
  // The sheet around the list scrolls, so the keyboard's highlight is kept in view as it moves.
  const activeId = active === undefined ? null : idFor(active);
  useEffect(() => {
    if (activeId !== null) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);
  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={0}
      aria-labelledby={labelledBy}
      aria-activedescendant={active === undefined ? undefined : idFor(active)}
      data-explorer-view={view}
      className={cn(
        'rounded-control focus-visible:outline-focus focus-visible:outline-offset-focus',
        card
          ? 'grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] content-start gap-xs'
          : 'grid content-start gap-0.5',
      )}
      onKeyDown={onKeyDown}
    >
      {entries.map(entry => {
        const folder = entry.kind === 'folder';
        const highlighted = folder && entry.name === highlightedName;
        return (
          <div
            key={entry.name}
            id={idFor(entry)}
            role="option"
            aria-selected={highlighted}
            aria-disabled={folder ? undefined : true}
            data-explorer-entry={entry.name}
            data-explorer-kind={entry.kind}
            data-explorer-highlighted={highlighted ? 'true' : 'false'}
            className={cn(
              'min-w-0 rounded-control border border-transparent',
              card
                ? 'flex flex-col items-center gap-1 border-border-soft bg-surface-2 px-2 py-3 text-center'
                : 'flex min-h-control items-center gap-sm px-control-x py-1',
              folder ? 'cursor-pointer text-fg hover:bg-surface' : 'text-faint',
              highlighted && 'border-accent bg-accent-soft',
            )}
            // Click-to-open, not select-then-open: the one highlight is the keyboard's, and a tap on a phone must go
            // straight in. "Use this folder" chooses the folder that is open.
            onClick={folder ? () => onOpen(entry) : undefined}
            // Focus stays on the listbox (whose keys move the highlight): a press on an entry does not take it.
            tabIndex={-1}
            onMouseDown={event => event.preventDefault()}
            onKeyDown={event => {
              if (folder && event.target === event.currentTarget && event.key === ' ') {
                event.preventDefault();
                onOpen(entry);
              }
            }}
          >
            <EntryIcon entry={entry} size={card ? 28 : 16} />
            <span className={cn('min-w-0 truncate text-ui', card && 'w-full')}>{entry.name}</span>
            {entry.isRepo && <RepoBadge />}
            {!card && <span className="ml-auto shrink-0 text-meta text-faint">{when(entry.modifiedAt)}</span>}
          </div>
        );
      })}
    </div>
  );
});
