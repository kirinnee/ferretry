/**
 * ONE FILE TAB, ONE FILE. The body behind a `file:<path>` instance tab.
 *
 * `FilesTab` is the PICKER — the directory tree and listing. This is the
 * VIEWER, and there is one mounted per open file tab, so opening `api.ts` and
 * `README.md` gives two tabs each showing its own file with its own raw/diff
 * choice, exactly as an editor behaves (handover #35,
 * `DESIGN-side-pane-tabs.md` — "Rendering instance tabs / file").
 *
 * Everything it reads is addressed to the daemon in `scope`: the resource keys
 * carry `daemonSessionKey`, so one daemon's bytes can never be served under
 * another's tab. The instance's `revision` is the re-delivery counter — the
 * same path delivered again with a new line range scrolls again rather than
 * sitting silently on the old position.
 *
 * A file that cannot be read renders as a failure with retry. It never renders
 * as an empty file: a damaged read is not an empty one.
 *
 * Reload (handover #37) is a LABELLED action, and it never costs the reader
 * what they were already reading: the previously loaded bytes stay mounted —
 * same nodes, same scroll offset, same raw/diff choice — while the reread runs
 * and after it fails, with one live notice saying which copy is on screen. Only
 * a successful reread replaces them, and only then does `file.revision` move,
 * which is what tells the rich preview that new bytes actually landed.
 */

import { Code2, GitCompareArrows, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionKey, type DaemonSessionScope } from '../lib/daemon-scope.ts';
import { formatCodeReference } from '../lib/references.ts';
import type { SidePaneTabInstance } from '../shell/side-pane-tab-model.ts';
import { fsApi, useFsProbe, type FsFile } from './files-api.ts';
import { baseName, parseUnifiedDiff, renderableDiffLines } from './files-model.ts';
import { useFsResource } from './files-resource.ts';
import { type FileLineSelection, type FileView, scrollFileLineIntoView } from './files-tab-model.ts';
import {
  DiffBody,
  Failed,
  FileBody,
  type FilesMarkdownContext,
  Loading,
  Note,
  ReloadAction,
  StaleNotice,
  Unavailable,
} from './files-views.tsx';

export interface FileInstanceSurfaceProps {
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** The open instance this body belongs to. `instance.key` IS the path. */
  readonly instance: SidePaneTabInstance;
  /** Proof and navigation for Markdown previews; without it, prose. */
  readonly markdown?: FilesMarkdownContext;
}

/**
 * The delivered line range, or nothing.
 *
 * `SidePaneFileSelection` and `FileLineSelection` are the same three fields;
 * this narrows the instance's field rather than keeping a second copy that
 * could disagree with the strip.
 */
const instanceSelection = (instance: SidePaneTabInstance): FileLineSelection | undefined => instance.selection;

export const FileInstanceSurface = ({ daemon, scope, instance, markdown }: FileInstanceSurfaceProps) => {
  const probe = useFsProbe(daemon, scope);
  const path = instance.key;
  const key = daemonSessionKey(scope);
  const [view, setView] = useState<FileView>('normal');
  // The reader can dismiss a delivered highlight; a NEW delivery (a bumped
  // revision) must bring it back, so the dismissal is remembered against the
  // revision it dismissed rather than as a bare boolean.
  const [dismissedRevision, setDismissedRevision] = useState<number | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLSpanElement>(null);

  const delivered = instanceSelection(instance);
  const selection = dismissedRevision === instance.revision ? undefined : delivered;
  const unavailable = probe.state === 'unsupported';
  const repo = probe.changes?.repo ?? false;
  // A highlighted line has to come from the file itself — a diff has no line
  // numbering to scroll to — so a delivery wins over the reader's diff choice
  // until the highlight is cleared, exactly as the browse surface behaved.
  const diffActive = view === 'diff' && selection === undefined;

  const diff = useFsResource<string>(
    !unavailable && diffActive ? `diff:${key}:${path}` : null,
    useCallback(signal => fsApi.diff(daemon, scope, path, signal), [daemon, scope, path]),
  );
  const file = useFsResource<FsFile>(
    !unavailable && !diffActive ? `file:${key}:${path}` : null,
    useCallback(signal => fsApi.file(daemon, scope, path, undefined, signal), [daemon, scope, path]),
  );

  // `instance.revision` is a dependency ON PURPOSE: re-delivering the same path
  // with the same range is a real event, and without it the second delivery
  // would leave the reader wherever they had scrolled to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the re-delivery trigger, not a read value
  useEffect(() => {
    if (!selection || !file.data) return;
    const pane = paneRef.current;
    const target = targetLineRef.current;
    if (!pane || !target) return;
    scrollFileLineIntoView(pane, target);
  }, [selection, file.data, instance.revision]);

  const parsedDiff = useMemo(() => (diff.data === null ? null : parseUnifiedDiff(diff.data)), [diff.data]);
  const diffHasBody = useMemo(() => (parsedDiff ? renderableDiffLines(parsedDiff).length > 0 : false), [parsedDiff]);

  if (unavailable)
    return (
      <div className="kt-fs rounded-md border border-border bg-surface">
        <Unavailable detail={probe.error} />
      </div>
    );

  const title = formatCodeReference({ path, ...selection });
  const rawActive = view === 'raw';
  // ONE resource is on screen at a time, so one decision — the hook's own —
  // says whether what is shown is the newest, and both the control and the
  // notice read it rather than each working it out again.
  const shown = diffActive ? diff : file;
  const reload = () => {
    probe.refresh();
    shown.reload();
  };

  return (
    <div className="kt-fs rounded-md border border-border bg-surface">
      <div className="kt-fs-bar">
        <span className="kt-fs-title" title={title}>
          <span className="kt-fs-title-path">{title}</span>
        </span>
        <span className="kt-fs-actions">
          {selection && (
            <button
              type="button"
              className="kt-fs-icon-button"
              onClick={() => setDismissedRevision(instance.revision)}
              aria-label={`Clear line selection for ${path}`}
              title={view === 'diff' ? 'Clear highlight and return to diff' : 'Clear line highlight'}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="kt-fs-icon-button"
            data-active={rawActive || undefined}
            aria-pressed={rawActive}
            onClick={() => setView(rawActive ? 'normal' : 'raw')}
            aria-label={rawActive ? `Show ${path} normally` : `Show raw bytes for ${path}`}
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
              onClick={() => setView(diffActive ? 'normal' : 'diff')}
              aria-label={diffActive ? `Show ${path} normally` : `Show git diff for ${path}`}
              title={diffActive ? 'Show file' : 'Show git diff'}
            >
              <GitCompareArrows size={17} aria-hidden="true" />
            </button>
          )}
          <ReloadAction what={path} busy={shown.refreshing || probe.refreshing} onReload={reload} />
        </span>
      </div>

      <StaleNotice what={diffActive ? 'the diff' : baseName(path)} status={shown} onRetry={reload} />

      <div className="kt-fs-body">
        <div ref={paneRef} tabIndex={-1} className="kt-fs-scroll scroll-thin outline-none">
          {/* Retained content is checked FIRST: a reload that is in flight, or one
              that failed, still has the bytes the reader was looking at, and
              swapping them for a spinner is what loses the reading position. */}
          {diffActive ? (
            parsedDiff === null ? (
              diff.loading ? (
                <Loading what="the diff" />
              ) : diff.error ? (
                <Failed what="the diff" error={diff.error} onRetry={diff.reload} />
              ) : (
                <Note role="status">Nothing to show.</Note>
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
                    Showing the first {parsedDiff.lines.length.toLocaleString()} of {parsedDiff.total.toLocaleString()}{' '}
                    diff lines.
                  </div>
                )}
              </>
            ) : (
              <Note role="status">No textual changes in this file.</Note>
            )
          ) : file.data ? (
            <FileBody
              file={file.data}
              path={path}
              raw={rawActive}
              selection={selection}
              targetLineRef={targetLineRef}
              markdown={markdown}
              preview={{ daemon, scope, revision: file.revision }}
            />
          ) : file.loading ? (
            <Loading what={baseName(path)} />
          ) : file.error ? (
            <Failed what={baseName(path)} error={file.error} onRetry={file.reload} />
          ) : (
            <Note role="status">Nothing to show.</Note>
          )}
        </div>
      </div>
    </div>
  );
};
