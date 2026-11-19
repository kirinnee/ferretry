/**
 * THE FOLDER EXPLORER: a Windows-Explorer-style picker that starts at the home folder.
 *
 * Presentational on purpose: a listing in, callbacks out, so the unit tier and the screenshot harness drive the shipped
 * component. `folder-picker.tsx` is the half bound to a daemon.
 *
 * - Breadcrumbs from the home folder down; each is a link back up, and an Up button goes one level.
 * - The fence: the explorer never leaves the home folder, and at the home it SAYS so instead of drawing a dead Up.
 * - Card or list, remembered per device (the toggle is a native radio group).
 * - A git badge on repository folders; New folder inline.
 * - Keyboard: arrows move the one highlight, Enter opens it, Backspace goes up, Home/End jump.
 * - NO FLICKER: while the next folder is read the current one stays drawn (`aria-busy`), and a failed read is stated
 *   beside it instead of blanking it.
 */
import { ArrowUp, ChevronRight, FolderPlus, LayoutGrid, List, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { cn } from '@ferretry/app/ui';
import type { FolderEntry, FolderListing } from '../../../contract/index.ts';
import { ExplorerEntries } from './explorer-entries.tsx';
import {
  childPath,
  type ExplorerView,
  type ExplorerViewChoice,
  folderEntries,
  moveHighlight,
  type NavKey,
  parentPath,
  truncationSentence,
} from './explorer-model.ts';
import { NewFolderRow } from './new-folder-row.tsx';

export interface FolderExplorerProps {
  readonly listing: FolderListing | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly view: ExplorerView;
  readonly onViewChange: (choice: ExplorerViewChoice) => void;
  readonly showHidden: boolean;
  readonly onShowHiddenChange: (show: boolean) => void;
  /** Go into a folder, or to a crumb. */
  readonly onOpen: (path: string) => void;
  /** Choose the folder that is open. Omitted when the caller's own button (a stepper's Next) chooses the open folder. */
  readonly onChoose?: (path: string) => void;
  /** Makes a folder in the open one; `null` = made, else the daemon's sentence. */
  readonly onMakeFolder: (name: string) => Promise<string | null>;
  readonly chooseLabel?: string;
}

const NAV_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** How many columns the card grid has right now (1 in a list, or where layout is unmeasured). */
const columnsOf = (element: HTMLElement | null, view: ExplorerView): number => {
  if (element === null || view === 'list') return 1;
  const template = globalThis.getComputedStyle?.(element).gridTemplateColumns ?? '';
  return Math.max(1, template.split(' ').filter(Boolean).length);
};

export function FolderExplorer(props: FolderExplorerProps) {
  const { listing, loading, error, view, onViewChange, showHidden, onShowHiddenChange, onOpen, onChoose } = props;
  const headingId = useId();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<{ readonly path: string; readonly name: string | null }>({
    path: '',
    name: null,
  });
  const [creating, setCreating] = useState(false);

  if (listing === null) {
    return (
      <div className="grid gap-sm" data-explorer-state={error === null ? 'loading' : 'failed'} aria-busy={loading}>
        {error === null ? (
          <p className="m-0 flex items-center gap-xs text-meta text-muted" role="status">
            <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />
            Reading your home folder…
          </p>
        ) : (
          <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
            <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
            Could not read the folders: {error}
          </p>
        )}
      </div>
    );
  }

  const folders = folderEntries(listing);
  // The highlight belongs to the folder it was made in: moving on starts clean, with nothing carried over.
  const highlightedName = highlight.path === listing.path ? highlight.name : null;
  const highlightedIndex = folders.findIndex(entry => entry.name === highlightedName);
  const up = parentPath(listing);
  const idFor = (entry: FolderEntry): string => `${listId}-${entry.name}`;
  const truncated = truncationSentence(listing);
  const home = listing.crumbs[0]?.path ?? listing.path;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (NAV_KEYS.has(event.key)) {
      event.preventDefault();
      const index = moveHighlight(
        highlightedIndex,
        event.key as NavKey,
        folders.length,
        columnsOf(listRef.current, view),
      );
      setHighlight({ path: listing.path, name: folders[index]?.name ?? null });
    } else if (event.key === 'Enter' && highlightedIndex >= 0) {
      event.preventDefault();
      onOpen(childPath(listing, folders[highlightedIndex] as FolderEntry));
    } else if (event.key === 'Backspace' && up !== null) {
      event.preventDefault();
      onOpen(up);
    }
  };

  return (
    <div className="grid min-h-0 gap-sm" data-explorer-state="ready" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-xs">
        <div className="flex min-w-0 items-center gap-xs">
          {up !== null && (
            <button
              type="button"
              className="kt-btn min-h-control shrink-0"
              aria-label="Up one folder"
              data-explorer-up={up}
              onClick={() => onOpen(up)}
            >
              <ArrowUp size={14} aria-hidden="true" />
              Up
            </button>
          )}
          <nav aria-label="Folder path" className="min-w-0">
            <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-0.5 p-0 text-ui" id={headingId}>
              {listing.crumbs.map((crumb, index) => {
                const last = index === listing.crumbs.length - 1;
                return (
                  <li key={crumb.path} className="flex items-center gap-0.5">
                    {index > 0 && <ChevronRight className="text-faint" size={12} aria-hidden="true" />}
                    <button
                      type="button"
                      className={cn(
                        'min-h-control rounded-control px-1.5 hover:bg-surface-2',
                        last ? 'font-semibold text-fg' : 'text-muted',
                      )}
                      aria-current={last ? 'page' : undefined}
                      data-explorer-crumb={crumb.path}
                      onClick={() => onOpen(crumb.path)}
                    >
                      {crumb.name}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </div>
        <div className="flex items-center gap-xs">
          <fieldset className="relative m-0 flex gap-0.5 border-0 p-0">
            <legend className="sr-only">How to show folders</legend>
            {(
              [
                ['card', 'Cards', LayoutGrid],
                ['list', 'List', List],
              ] as const
            ).map(([choice, label, Icon]) => (
              <label
                key={choice}
                data-explorer-view-choice={choice}
                className={cn(
                  'inline-flex min-h-control cursor-pointer items-center gap-1 rounded-control border px-2 text-meta has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus',
                  view === choice
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border text-muted hover:border-accent',
                )}
              >
                <input
                  type="radio"
                  name={`explorer-view-${listId}`}
                  className="sr-only"
                  checked={view === choice}
                  onChange={() => onViewChange(choice)}
                />
                <Icon size={14} aria-hidden="true" />
                {label}
              </label>
            ))}
          </fieldset>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-xs">
        <button
          type="button"
          className="kt-btn min-h-control"
          onClick={() => setCreating(open => !open)}
          aria-expanded={creating}
        >
          <FolderPlus size={14} aria-hidden="true" />
          New folder
        </button>
        <label className="flex min-h-control items-center gap-xs text-meta text-muted">
          <input
            type="checkbox"
            role="switch"
            aria-checked={showHidden}
            className="relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-border-strong transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-bg after:transition-transform checked:bg-accent checked:after:translate-x-4 focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none motion-reduce:after:transition-none"
            checked={showHidden}
            onChange={event => onShowHiddenChange(event.target.checked)}
          />
          Show hidden folders
        </label>
      </div>

      {up === null && (
        <p className="m-0 text-meta text-faint" data-explorer-fence="">
          Ferretry can only open folders inside <span className="mono break-all text-muted">{home}</span>.
        </p>
      )}

      {creating && (
        <NewFolderRow
          onCancel={() => setCreating(false)}
          onMake={async name => {
            const sentence = await props.onMakeFolder(name);
            if (sentence === null) setCreating(false);
            return sentence;
          }}
        />
      )}

      {error !== null && (
        <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          Could not refresh this folder: {error}
        </p>
      )}

      {folders.length === 0 ? (
        <p
          className="m-0 rounded-control border border-border-soft bg-surface-2 p-panel text-meta text-faint"
          data-explorer-empty=""
        >
          {listing.entries.length === 0 ? 'This folder is empty.' : 'No folders in here.'}
        </p>
      ) : (
        <ExplorerEntries
          ref={listRef}
          entries={folders}
          view={view}
          highlightedName={highlightedName}
          idFor={idFor}
          labelledBy={headingId}
          onKeyDown={onKeyDown}
          onOpen={entry => onOpen(childPath(listing, entry))}
        />
      )}
      {truncated !== null && (
        <p className="m-0 text-meta text-warn" role="status" data-explorer-truncated="">
          {truncated}
        </p>
      )}

      {onChoose !== undefined && (
        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            className="kt-btn min-h-control"
            data-variant="primary"
            onClick={() => onChoose(listing.path)}
          >
            {props.chooseLabel ?? 'Use this folder'}
          </button>
          <span className="mono min-w-0 break-all text-meta text-muted" data-explorer-path="">
            {listing.path}
          </span>
        </div>
      )}
    </div>
  );
}
