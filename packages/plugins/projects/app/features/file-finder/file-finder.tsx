/**
 * A PROJECT'S FILE FINDER (&F6061 U7): search the names of every file in a registered project folder that Git does not
 * ignore, from the project page. The daemon owns the index and the search; this draws what it answers.
 *
 * What a person sees is exactly what the daemon says it could see: the coverage banner (where a bound bit, which folders
 * hold the most files, what was skipped), "Updating…" while a newer index is being built, and a Rescan button. An empty
 * result over a partial index never says there is nothing there (`emptyResultSentence`).
 *
 * A row COPIES the file's absolute path. Opening a file's content is the ferret file page's read, which re-checks every
 * path; the finder is names only and goes no further than naming.
 */
import { Loading, Spinner } from '@ferretry/app/ui';
import { Check, File, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import type { ProjectInfo } from '../../../contract/index.ts';
import { relativeTime } from '../../lib/folders.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import {
  absolutePath,
  coverageBanner,
  emptyResultSentence,
  foldersLine,
  matchCountLine,
  splitPath,
} from './finder-model.ts';
import { type FileFinderTimings, useFileFinder } from './use-file-finder.ts';

/** Puts text on the clipboard, saying whether it did; a browser without one (or one that refuses) is not an error. */
const copyText = async (text: string): Promise<boolean> => {
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
    return globalThis.navigator?.clipboard !== undefined;
  } catch {
    return false;
  }
};

export interface FileFinderProps {
  readonly client: ProjectsClient;
  readonly project: Pick<ProjectInfo, 'id' | 'path'>;
  /** What the box starts with (an address's `?find=`). */
  readonly initialQuery?: string;
  readonly timings?: FileFinderTimings;
  /** The wall clock, for "updated 3m ago". */
  readonly now?: () => number;
}

export function FileFinder({ client, project, initialQuery = '', timings, now = Date.now }: FileFinderProps) {
  const [query, setQuery] = useState(initialQuery);
  const [copied, setCopied] = useState<string | null>(null);
  const finder = useFileFinder(client, project.id, query, timings);
  const { answer } = finder;

  if (answer === null) {
    if (finder.error !== null)
      return (
        <div className="grid gap-xs" data-finder-state="failed">
          <p className="m-0 text-meta text-warn" role="status" data-finder-error="">
            Could not read this project’s files: {finder.error}
          </p>
          <button type="button" className="kt-btn kt-btn--sm w-fit" onClick={finder.rescan}>
            Try again
          </button>
        </div>
      );
    return (
      <div data-finder-state="loading" aria-busy="true">
        <Loading kind="bar" label="Looking through this project’s files…" />
      </div>
    );
  }

  const banner = coverageBanner(answer.index);
  const folders = banner === null ? null : foldersLine(banner.folders);
  const counted = matchCountLine(answer.files.length, answer.total);
  const settled = finder.answeredFor !== null && !finder.loading;
  const built = relativeTime(answer.index.builtAt, now());

  const copy = (path: string): void => {
    void copyText(absolutePath(project.path, path)).then(done => setCopied(done ? path : null));
  };

  return (
    <div className="grid gap-sm" data-finder-state="ready" data-finder-coverage={answer.index.coverage}>
      <div className="flex min-w-0 items-center gap-xs">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search files in this project</span>
          <Search
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
            size={14}
            aria-hidden="true"
          />
          <input
            className="kt-input min-h-control w-full pl-7"
            type="search"
            value={query}
            placeholder="Find a file by name or path"
            autoComplete="off"
            spellCheck={false}
            onChange={event => {
              setQuery(event.target.value);
              setCopied(null);
            }}
            data-finder-input=""
          />
        </label>
        <button
          type="button"
          className="kt-btn min-h-control shrink-0"
          onClick={finder.rescan}
          disabled={finder.rebuilding}
          data-finder-rescan=""
        >
          {finder.rebuilding ? <Spinner size={13} /> : <RefreshCw size={13} aria-hidden="true" />}{' '}
          {finder.rebuilding ? 'Updating…' : 'Rescan'}
        </button>
      </div>

      <p className="m-0 text-meta text-muted" data-finder-built="">
        {answer.index.indexed.toLocaleString('en-US')} files indexed · updated {built}
      </p>

      {banner !== null && (
        <section
          className="grid gap-1 rounded-control border border-border-strong bg-surface-2 p-sm text-meta leading-base text-fg"
          aria-label="What the index could see"
          data-finder-banner={banner.kind}
        >
          {banner.headline !== null && <p className="m-0 font-medium">{banner.headline}</p>}
          {folders !== null && <p className="m-0 text-muted">{folders}</p>}
          {banner.skipped !== null && <p className="m-0 text-muted">{banner.skipped}</p>}
          {banner.tip !== null && <p className="m-0 text-muted">{banner.tip}</p>}
        </section>
      )}

      {finder.error !== null && (
        <p className="m-0 text-meta text-warn" role="status" data-finder-error="">
          Could not refresh: {finder.error}. Showing the last answer.
        </p>
      )}

      {answer.files.length === 0 ? (
        settled && (
          <p className="m-0 text-meta text-muted" role="status" data-finder-empty="">
            {emptyResultSentence(finder.answeredFor ?? '', answer.index)}
          </p>
        )
      ) : (
        <ul
          className="m-0 grid list-none gap-0 p-0"
          aria-label="Matching files"
          aria-busy={finder.loading}
          data-finder-results=""
        >
          {answer.files.map(file => {
            const { folder, name } = splitPath(file.path);
            return (
              <li key={file.path} className="min-w-0">
                <button
                  type="button"
                  className="grid min-h-control w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-xs rounded-control px-xs py-1 text-left hover:bg-surface-2 focus-visible:bg-surface-2"
                  onClick={() => copy(file.path)}
                  aria-label={`Copy the path of ${file.path}`}
                  data-finder-row={file.path}
                >
                  <File className="shrink-0 text-faint" size={14} aria-hidden="true" />
                  <span className="min-w-0 truncate text-ui">
                    <span className="font-medium text-fg">{name}</span>
                    {folder !== '' && <span className="mono ml-xs text-2xs text-muted">{folder}</span>}
                  </span>
                  {copied === file.path && (
                    <span className="flex items-center gap-1 text-2xs text-accent" role="status">
                      <Check size={12} aria-hidden="true" /> Copied
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {counted !== null && (
        <p className="m-0 text-meta text-muted" data-finder-count="">
          {counted} Type more to narrow them.
        </p>
      )}
    </div>
  );
}
