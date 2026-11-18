/**
 * One open file as an INSTANCE — the `file:<path>` tab's own screen. Ported from `pwa/src/components/file-instance-surface.tsx`.
 *
 * It is everything that belongs to ONE file and nothing that belongs to the tree beside it: the bar (back, the file's
 * path, clear the line highlight, raw, git diff, Reload), the stale/refresh notice and the body (the rendered file, its
 * raw bytes, or its diff). Which files are open, which one is on show and the picker are `FilesTab`'s.
 *
 * Reload is the same contract the browse view honours: what is already on screen stays there while it runs and if it
 * fails, and one notice says which copy is being read. The raw / diff / selection state lives in the TAB
 * (`OpenFileTab`), so switching tabs restores each file exactly as it was left.
 */

import { ArrowLeft, Code2, GitCompareArrows, X } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef } from 'react';
import { formatCodeReference } from '@ferretry/app';
import { useInputModality } from '@ferretry/app/ui';
import { fsApi } from './files-api.ts';
import { baseName, parseUnifiedDiff, renderableDiffLines } from './files-model.ts';
import { ReloadAction, StaleNotice } from './files-reload.tsx';
import { useFsResource } from './files-resource.ts';
import { type FileView, type OpenFileTab, scrollFileLineIntoView } from './files-tab-model.ts';
import { DiffBody, Failed, FileBody, Loading, Note } from './files-views.tsx';
import type { FilesScope } from './scope.ts';
import { scopeKey } from './scope.ts';
import type { FsFile } from './wire.ts';

export interface FileInstanceSurfaceOptions {
  scope: FilesScope;
  /** The tab on show: its path, its view and any line selection a reference asked for. Null reads and draws nothing. */
  tab: OpenFileTab | null;
  /** Whether the folder is a git repository: only then is there a diff to offer. */
  repo: boolean;
  /** The picker's own change probe is re-read by Reload too, so its busy state joins this one's. */
  probeRefreshing: boolean;
  onReloadProbe: () => void;
  onBack: () => void;
  onViewChange: (view: FileView) => void;
  onClearSelection: () => void;
  /**
   * Bumped by the host when an open should move focus into the content (never on touch, where an unrequested focus
   * summons the keyboard). Switching between EXISTING tabs never bumps it, so focus stays where the reader put it.
   */
  focusRequest: number;
  /** The newest request already acted on: remounting for an EXISTING tab carries the same number and pulls no focus. */
  focusedRequest: { current: number };
}

/**
 * The pieces of the open file's screen. They are returned rather than drawn as one component so the host lays them
 * out in the SAME frame it browses in: the folder tree beside the content stays mounted (hidden) while a file is open,
 * and a component boundary here would remount it and forget which folders were expanded.
 */
export interface FileInstanceParts {
  readonly bar: ReactNode;
  readonly notice: ReactNode;
  readonly body: ReactNode;
  /** The scroller the body sits in: focus and line selection act on it. */
  readonly paneRef: RefObject<HTMLDivElement | null>;
}

export const useFileInstanceSurface = ({
  scope,
  tab,
  repo,
  probeRefreshing,
  onReloadProbe,
  onBack,
  onViewChange,
  onClearSelection,
  focusRequest,
  focusedRequest,
}: FileInstanceSurfaceOptions): FileInstanceParts | null => {
  const key = scopeKey(scope);
  const { touchAffected } = useInputModality();
  const paneRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLSpanElement>(null);
  const touchAffectedRef = useRef(touchAffected);
  touchAffectedRef.current = touchAffected;

  // `focusRequest` is the ONLY dependency on purpose — raw/diff changes and tab activation update `tab` but must keep
  // focus on the control used.
  const shown = tab !== null;
  useEffect(() => {
    if (!shown || touchAffectedRef.current || focusRequest === 0 || focusedRequest.current === focusRequest) return;
    focusedRequest.current = focusRequest;
    paneRef.current?.focus({ preventScroll: true });
  }, [focusRequest, focusedRequest, shown]);

  const diffActive = tab !== null && tab.view === 'diff' && tab.selection === undefined;
  const rawActive = tab?.view === 'raw';
  const diffPath = tab !== null && diffActive ? tab.path : null;
  const diff = useFsResource<string>(
    diffPath ? `diff:${key}:${diffPath}` : null,
    useCallback(signal => fsApi.diff(scope, diffPath ?? '', signal), [scope, diffPath]),
  );
  const filePath = tab === null || diffActive ? null : tab.path;
  const file = useFsResource<FsFile>(
    filePath ? `file:${key}:${filePath}` : null,
    useCallback(signal => fsApi.file(scope, filePath ?? '', undefined, signal), [scope, filePath]),
  );

  useEffect(() => {
    if (!tab?.selection || !file.data) return;
    const pane = paneRef.current;
    const target = targetLineRef.current;
    if (!pane || !target) return;
    scrollFileLineIntoView(pane, target);
  }, [tab?.selection, file.data]);

  const parsedDiff = useMemo(() => (diff.data === null ? null : parseUnifiedDiff(diff.data)), [diff.data]);
  // A diff that is nothing but plumbing headers has nothing to show — the emptiness test has to agree with what
  // DiffBody actually renders.
  const diffHasBody = useMemo(() => (parsedDiff ? renderableDiffLines(parsedDiff).length > 0 : false), [parsedDiff]);

  const resource = diffActive ? diff : file;
  const reload = () => {
    onReloadProbe();
    resource.reload();
  };

  if (tab === null) return null;
  const title = formatCodeReference({ path: tab.path, ...tab.selection });

  const bar = (
    <div className="kt-fs-bar">
      <button
        type="button"
        className="kt-fs-icon-button"
        onClick={onBack}
        aria-label="Back to the file list"
        title="Back to files"
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </button>
      <span className="kt-fs-title" title={title}>
        <span className="kt-fs-title-path">{title}</span>
      </span>
      <span className="kt-fs-actions">
        {tab.selection && (
          <button
            type="button"
            className="kt-fs-icon-button"
            onClick={onClearSelection}
            aria-label={`Clear line selection for ${tab.path}`}
            title={tab.view === 'diff' ? 'Clear highlight and return to diff' : 'Clear line highlight'}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="kt-fs-icon-button"
          data-active={rawActive || undefined}
          aria-pressed={rawActive}
          onClick={() => onViewChange(rawActive ? 'normal' : 'raw')}
          aria-label={rawActive ? `Show ${tab.path} normally` : `Show raw bytes for ${tab.path}`}
          title={rawActive ? 'Show normally' : 'Show raw'}
        >
          <Code2 size={17} aria-hidden="true" />
        </button>
        {repo && (
          <button
            type="button"
            className="kt-fs-icon-button"
            data-active={diffActive || undefined}
            aria-pressed={diffActive}
            onClick={() => onViewChange(diffActive ? 'normal' : 'diff')}
            aria-label={diffActive ? `Show ${tab.path} normally` : `Show git diff for ${tab.path}`}
            title={diffActive ? 'Show file' : 'Show git diff'}
          >
            <GitCompareArrows size={17} aria-hidden="true" />
          </button>
        )}
        <ReloadAction what={tab.path} busy={resource.refreshing || probeRefreshing} onReload={reload} />
      </span>
    </div>
  );

  // Directly above the content it is about, and OUTSIDE the scroller: the reading position is part of what a reload
  // preserves.
  const notice = (
    <StaleNotice dismissible what={diffActive ? 'the diff' : baseName(tab.path)} status={resource} onRetry={reload} />
  );

  const body = (
    <>
      {/* Retained content is checked FIRST: the reader keeps the bytes and the scroll offset while a reload runs
              or after it fails. */}
      {diffActive ? (
        // Two answers, not three: a settled successful diff read is never null (`fsApi.diff` resolves a string),
        // so there is no fourth state to describe.
        parsedDiff === null ? (
          diff.error === null ? (
            <Loading what="the diff" kind="page" />
          ) : (
            <Failed what="the diff" error={diff.error} onRetry={diff.reload} />
          )
        ) : parsedDiff.binary ? (
          <Note tone="warn" role="status">
            git reports this pair as binary — there is no textual diff to show.
          </Note>
        ) : diffHasBody ? (
          <>
            <DiffBody parsed={parsedDiff} />
            {parsedDiff.truncated && (
              <div className="kt-fs-note" role="status">
                Showing the first {parsedDiff.lines.length.toLocaleString()} of {parsedDiff.total.toLocaleString()} diff
                lines.
              </div>
            )}
          </>
        ) : (
          <Note role="status">No textual changes in this file.</Note>
        )
      ) : file.data ? (
        <FileBody
          file={file.data}
          path={tab.path}
          raw={rawActive}
          selection={tab.selection}
          targetLineRef={targetLineRef}
          preview={{ scope, revision: file.revision }}
        />
      ) : file.error ? (
        <Failed what={baseName(tab.path)} error={file.error} onRetry={file.reload} />
      ) : (
        <Loading what={baseName(tab.path)} kind="page" />
      )}
    </>
  );

  return { bar, notice, body, paneRef };
};
