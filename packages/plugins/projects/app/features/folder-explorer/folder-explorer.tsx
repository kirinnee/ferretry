/**
 * THE FOLDER EXPLORER: a Windows-Explorer-style picker that starts at the home folder.
 *
 * Presentational on purpose: a listing in, callbacks out, so the unit tier and the screenshot harness drive the shipped
 * component. `folder-picker.tsx` is the half bound to a daemon.
 *
 * - A path box (type a path, Enter) above breadcrumbs from the home folder down; each is a link back up, and an Up button goes one level.
 * - The fence: the explorer never leaves the home folder, and at the home it SAYS so instead of drawing a dead Up.
 * - Card or list, remembered per device (the toggle is a native radio group).
 * - A git badge on repository folders; New folder inline.
 * - Keyboard: arrows move the one highlight, Enter opens it, Backspace goes up, Home/End jump.
 * - NO FLICKER: while the next folder is read the current one stays drawn (`aria-busy`), and a failed read is stated
 *   beside it instead of blanking it.
 */
import { ArrowUp, ChevronRight, FolderPlus, LayoutGrid, List, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { cn, Spinner } from '@ferretry/app/ui';
import type { FolderEntry, FolderListing } from '../../../contract/index.ts';
import { BROAD_ROOT_WARNING } from '../../lib/registration-model.ts';
import { ExplorerEntries } from './explorer-entries.tsx';
import {
  childPath,
  displayPath,
  type ExplorerView,
  type ExplorerViewChoice,
  folderEntries,
  moveHighlight,
  type NavKey,
  parentPath,
  truncationSentence,
} from './explorer-model.ts';
import { NewFolderRow } from './new-folder-row.tsx';
import { PathBox } from './path-box.tsx';

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
  /**
   * Whether the open folder being a broad root (`listing.broad`: the disk, a home, the folder every home sits in) is said out
   * loud. On by default: the picker chooses a project folder. Off for a caller that only picks a place to put something.
   */
  readonly warnBroad?: boolean;
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
  // The folder that was open when a path was typed: a refusal belongs to the typing only while that folder is still open.
  const [typedIn, setTypedIn] = useState<string | null>(null);

  if (listing === null) {
    return (
      <div className="grid gap-sm" data-explorer-state={error === null ? 'loading' : 'failed'} aria-busy={loading}>
        {error === null ? (
          <p className="fy-wait-gate m-0 flex items-center gap-xs text-meta text-muted" role="status">
            <Spinner size={14} />
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

  const open = (path: string): void => {
    setTypedIn(null);
    onOpen(path);
  };
  // The daemon's sentence for a typed path it refused goes under the path box; the old listing stays drawn above it.
  const pathRefusal = error !== null && typedIn === listing.path ? error : null;
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
      open(childPath(listing, folders[highlightedIndex] as FolderEntry));
    } else if (event.key === 'Backspace' && up !== null) {
      event.preventDefault();
      open(up);
    }
  };

  return (
    <div className="grid min-h-0 gap-sm" data-explorer-state="ready" aria-busy={loading}>
      <PathBox
        current={displayPath(listing)}
        refusal={pathRefusal}
        onGo={typed => {
          setTypedIn(listing.path);
          onOpen(typed);
        }}
        onRestore={() => {
          setTypedIn(null);
          // A refused read left the picker pointing at the refused path: point it back at the open folder.
          if (pathRefusal !== null) onOpen(listing.path);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-xs">
        <div className="flex min-w-0 items-center gap-xs">
          {up !== null && (
            <button
              type="button"
              className="kt-btn min-h-control shrink-0"
              aria-label="Up one folder"
              data-explorer-up={up}
              onClick={() => open(up)}
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
                      onClick={() => open(crumb.path)}
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

      {listing.broad === true && props.warnBroad !== false && (
        <p
          className="m-0 flex items-start gap-xs text-meta leading-base text-warn"
          role="status"
          data-explorer-broad=""
        >
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          <span>{BROAD_ROOT_WARNING}</span>
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

      {error !== null && pathRefusal === null && (
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
          onOpen={entry => open(childPath(listing, entry))}
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
