/**
 * The Files tab — a deliberately ordinary read-only file browser for ONE
 * session on ONE paired daemon. Ported from `ui/src/components/FilesTab.tsx`.
 *
 * ONE bar carries the path and the actions. Browsing: tree toggle, breadcrumbs,
 * Reload. Viewing: back, the file's path, and its view actions. The original's
 * standalone breadcrumb rail is gone on purpose — the crumbs ARE the bar's path
 * segment.
 *
 * Reload is the same contract the instance viewer honours: the labelled action
 * re-reads from the session host, what is already on screen stays there while
 * it runs and if it fails, and one notice says which copy is being read.
 *
 * MULTI-DAEMON. Every read is addressed to the daemon passed in, and the
 * remembered open-file tabs are keyed by `(daemonId, sessionId)`
 * (`files-tab-model.ts`). Switching the connection therefore cannot show one
 * daemon's directory, file bytes, diff or open-tab list under another's name;
 * while the remembered state is still being swapped in, the pane says it is
 * loading rather than painting the previous daemon's tree.
 */

import { ArrowLeft, Code2, GitCompareArrows, ListTree, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionSearchControl } from '../features/session-search/session-search.tsx';
import { useInputModality } from '../hooks/use-input-modality.ts';
import { useLayoutMode } from '../hooks/use-layout-mode.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../lib/daemon-scope.ts';
import { formatCodeReference } from '../lib/references.ts';
import { FileTree } from './file-tree.tsx';
import { type FsFile, type FsListing, fsApi, useFsProbe } from './files-api.ts';
import { baseName, crumbs, isOpenablePath, parseUnifiedDiff, renderableDiffLines } from './files-model.ts';
import { ReloadAction, StaleNotice } from './files-reload.tsx';
import { useFsResource } from './files-resource.ts';
import {
  type CodeReferenceOpenRequest,
  type ColumnCodeReference,
  type FileLineSelection,
  type FileView,
  filesTreeOpenByDefault,
  type OpenFileTab,
  readFilesTabState,
  scrollFileLineIntoView,
  selectionFromReference,
  writeFilesTabState,
} from './files-tab-model.ts';
import {
  BrowseList,
  DiffBody,
  Failed,
  FileBody,
  type FilesMarkdownContext,
  Loading,
  Note,
  OpenFileTabs,
  Unavailable,
} from './files-views.tsx';

export interface FilesTabProps {
  daemon: DaemonConnection;
  scope: DaemonSessionScope;
  /**
   * The session's working directory — the viewer's root, shown as the `root`
   * breadcrumb's title so it is obvious WHICH tree is being read.
   */
  cwd?: string;
  /** Programmatic open request from whichever surface hosts this pane. */
  requestedReference?: CodeReferenceOpenRequest | null;
  onRequestedReferenceHandled?: (sequence: number) => void;
  /** Proof and navigation the Markdown renderer needs; without it, prose. */
  markdown?: FilesMarkdownContext;
  /**
   * A host that owns a tab strip takes the opens.
   *
   * Handover #35 is one tab per file, and a host that gives every file its own
   * tab must not ALSO have this pane hold a second, competing strip of its own.
   * When this is supplied, the pane is purely the PICKER — the tree, the
   * listing and the breadcrumbs — and every row-open, every code reference and
   * every Markdown file link is handed to the host, which opens the file as its
   * own `file:<path>` tab rendered by `FileInstanceSurface`.
   *
   * Without it (a standalone host with no strip — the harness card), the pane
   * keeps its own open-file tabs and viewer, which is the only way it can show
   * a file at all.
   */
  onOpenFile?: (path: string, selection?: FileLineSelection) => void;
}

export const FilesTab = ({
  daemon,
  scope,
  cwd,
  requestedReference,
  onRequestedReferenceHandled,
  markdown,
  onOpenFile,
}: FilesTabProps) => {
  const probe = useFsProbe(daemon, scope);
  const layout = useLayoutMode();
  const key = daemonSessionKey(scope);
  const restored = readFilesTabState(scope);
  const [stateKey, setStateKey] = useState(key);
  const [dir, setDir] = useState(restored.dir);
  const [tabs, setTabs] = useState<readonly OpenFileTab[]>(restored.tabs);
  const [activePath, setActivePath] = useState<string | null>(restored.activePath);
  const [treePref, setTreePref] = useState<boolean | undefined>(restored.tree);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const { touchAffected } = useInputModality();
  const paneRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLSpanElement>(null);
  const handledReference = useRef<number | null>(null);
  const touchAffectedRef = useRef(touchAffected);
  touchAffectedRef.current = touchAffected;
  const stateMatchesScope = stateKey === key;

  useEffect(() => {
    if (stateMatchesScope) return;
    const next = readFilesTabState(scope);
    setDir(next.dir);
    setTabs(next.tabs);
    setActivePath(next.activePath);
    setTreePref(next.tree);
    setTreeRefresh(0);
    setFocusRequest(0);
    handledReference.current = null;
    setStateKey(key);
  }, [key, scope, stateMatchesScope]);

  // Read through a ref so the open callbacks keep stable identities whether or
  // not a host claims the opens — a changing `onOpenFile` must not re-run the
  // reference effect below and re-deliver a reference the pane already handled.
  const hostOpenRef = useRef(onOpenFile);
  hostOpenRef.current = onOpenFile;
  const hostOwnsTabs = onOpenFile !== undefined;

  const repo = probe.changes?.repo ?? false;
  const changes = useMemo(() => probe.changes?.changes ?? [], [probe.changes]);
  const changesTruncated = probe.changes?.truncated ?? false;
  const changeMap = useMemo(() => new Map(changes.map(change => [change.path, change])), [changes]);
  // Remembered state can carry an `activePath` written before a host claimed
  // the opens. A picker must not silently resurrect its own viewer from it, so
  // host ownership decides, not the stored snapshot.
  const active =
    !hostOwnsTabs && stateMatchesScope && activePath ? (tabs.find(tab => tab.path === activePath) ?? null) : null;

  const openFile = useCallback((path: string) => {
    const host = hostOpenRef.current;
    if (host) {
      host(path);
      return;
    }
    setTabs(current =>
      current.some(tab => tab.path === path)
        ? current.map(tab => (tab.path === path ? { path, view: 'normal' } : tab))
        : [...current, { path, view: 'normal' }],
    );
    setActivePath(path);
    // Opening from the directory replaces the control that held focus. Ask for
    // the content once; clicking an EXISTING file tab never increments this, so
    // tab switching leaves focus exactly where the reader put it.
    setFocusRequest(request => request + 1);
  }, []);

  const openReference = useCallback((reference: ColumnCodeReference) => {
    if (!isOpenablePath(reference.path)) return;
    const selection = selectionFromReference(reference);
    const host = hostOpenRef.current;
    if (host) {
      host(reference.path, selection);
      return;
    }
    setTabs(current =>
      current.some(tab => tab.path === reference.path)
        ? current.map(tab => (tab.path === reference.path ? { ...tab, selection } : tab))
        : [...current, { path: reference.path, view: 'normal', selection }],
    );
    setActivePath(reference.path);
    setFocusRequest(request => request + 1);
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      const index = tabs.findIndex(tab => tab.path === path);
      if (index < 0) return;
      const remaining = tabs.filter(tab => tab.path !== path);
      setTabs(remaining);
      setActivePath(current =>
        current === path ? (remaining[Math.min(index, remaining.length - 1)]?.path ?? null) : current,
      );
    },
    [tabs],
  );

  const setActiveView = useCallback(
    (view: FileView) => {
      if (!activePath) return;
      setTabs(current => current.map(tab => (tab.path === activePath ? { path: tab.path, view } : tab)));
    },
    [activePath],
  );

  const clearActiveSelection = useCallback(() => {
    if (!activePath) return;
    setTabs(current => current.map(tab => (tab.path === activePath ? { path: tab.path, view: tab.view } : tab)));
  }, [activePath]);

  useEffect(() => {
    if (!stateMatchesScope) return;
    writeFilesTabState(scope, { dir, tabs, activePath, ...(treePref === undefined ? {} : { tree: treePref }) });
  }, [activePath, dir, scope, stateMatchesScope, tabs, treePref]);

  useEffect(() => {
    if (!stateMatchesScope || !requestedReference || handledReference.current === requestedReference.sequence) return;
    handledReference.current = requestedReference.sequence;
    openReference(requestedReference.reference);
    onRequestedReferenceHandled?.(requestedReference.sequence);
  }, [onRequestedReferenceHandled, openReference, requestedReference, stateMatchesScope]);

  // Never on touch: an unrequested focus there summons the keyboard and jumps
  // the viewport (input capability, not viewport width, owns that policy).
  // `focusRequest` is the ONLY dependency on purpose — raw/diff changes and file
  // tab activation update `active` but must keep focus on the control used.
  useEffect(() => {
    if (touchAffectedRef.current || focusRequest === 0) return;
    paneRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  // A daemon that cannot serve this surface at all is answered ONCE, above. Nothing below is fetched
  // in that state — a listing request would only earn a second panel contradicting the first.
  const unavailable = probe.state === 'unsupported';

  const listing = useFsResource<FsListing>(
    stateMatchesScope && !active && !unavailable ? `list:${key}:${dir}` : null,
    useCallback(signal => fsApi.list(daemon, scope, dir, signal), [daemon, scope, dir]),
  );

  const diffPath = !unavailable && active?.view === 'diff' && active.selection === undefined ? active.path : null;
  const diff = useFsResource<string>(
    diffPath ? `diff:${key}:${diffPath}` : null,
    useCallback(signal => fsApi.diff(daemon, scope, diffPath ?? '', signal), [daemon, scope, diffPath]),
  );

  const filePath =
    !unavailable && active && (active.view !== 'diff' || active.selection !== undefined) ? active.path : null;
  const file = useFsResource<FsFile>(
    filePath ? `file:${key}:${filePath}` : null,
    useCallback(signal => fsApi.file(daemon, scope, filePath ?? '', undefined, signal), [daemon, scope, filePath]),
  );

  useEffect(() => {
    if (!active?.selection || !file.data) return;
    const pane = paneRef.current;
    const target = targetLineRef.current;
    if (!pane || !target) return;
    scrollFileLineIntoView(pane, target);
  }, [active?.selection, file.data]);

  const parsedDiff = useMemo(() => (diff.data === null ? null : parseUnifiedDiff(diff.data)), [diff.data]);
  // A diff that is nothing but plumbing headers has nothing to show — the
  // emptiness test has to agree with what DiffBody actually renders.
  const diffHasBody = useMemo(() => (parsedDiff ? renderableDiffLines(parsedDiff).length > 0 : false), [parsedDiff]);

  if (!stateMatchesScope)
    return (
      <div className="kt-fs rounded-md border border-border bg-surface">
        <Loading what="session files" />
      </div>
    );

  // No bar either: a breadcrumb to a tree that cannot be read, a tree toggle with nothing to toggle
  // and a Reload that re-asks a settled question are three more controls that cannot work.
  if (unavailable)
    return (
      <div className="kt-fs rounded-md border border-border bg-surface">
        <Unavailable detail={probe.error} />
      </div>
    );

  const title = active ? formatCodeReference({ path: active.path, ...active.selection }) : '';
  const rawActive = active?.view === 'raw';
  const diffActive = active?.view === 'diff' && active.selection === undefined;
  const treeOpen = filesTreeOpenByDefault(treePref, layout);
  // The pane shows exactly one resource at a time, and the SAME decision the
  // instance viewer uses — the hook's own — says whether it is the newest.
  const shown = diffActive ? diff : active ? file : listing;
  const shownWhat = active ? (diffActive ? 'the diff' : baseName(active.path)) : dir || 'the session root';
  const reload = () => {
    probe.refresh();
    shown.reload();
    if (!active) setTreeRefresh(nonce => nonce + 1);
  };

  return (
    // `.kt-fs` owns flex:1 + min-height:0 (files.css) — the pane fills what the
    // page gives it and its scroller, not the page, takes the overflow.
    <div className="kt-fs rounded-md border border-border bg-surface">
      <div className="kt-fs-bar">
        {active ? (
          <button
            type="button"
            className="kt-fs-icon-button"
            onClick={() => setActivePath(null)}
            aria-label="Back to the file list"
            title="Back to files"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="kt-fs-icon-button"
            data-active={treeOpen || undefined}
            aria-pressed={treeOpen}
            onClick={() => setTreePref(!treeOpen)}
            aria-label={treeOpen ? 'Hide the folder tree' : 'Show the folder tree'}
            title={treeOpen ? 'Hide tree' : 'Show tree'}
          >
            <ListTree size={16} aria-hidden="true" />
          </button>
        )}
        {active ? (
          <span className="kt-fs-title" title={title}>
            <span className="kt-fs-title-path">{title}</span>
          </span>
        ) : (
          <nav className="kt-fs-crumbs scroll-thin" aria-label="Folder path">
            {crumbs(dir).map((crumb, index) => (
              <span key={crumb.path || 'root'} className="contents">
                {index > 0 && (
                  <span className="kt-fs-crumb-sep" aria-hidden="true">
                    /
                  </span>
                )}
                <button
                  type="button"
                  className="kt-fs-crumb"
                  aria-current={crumb.path === dir ? 'page' : undefined}
                  onClick={() => setDir(crumb.path)}
                  title={index === 0 ? cwd : crumb.path}
                  aria-label={index === 0 ? `Go to the session root${cwd ? ` (${cwd})` : ''}` : `Go to ${crumb.path}`}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
        )}
        <span className="kt-fs-actions">
          {active?.selection && (
            <button
              type="button"
              className="kt-fs-icon-button"
              onClick={clearActiveSelection}
              aria-label={`Clear line selection for ${active.path}`}
              title={active.view === 'diff' ? 'Clear highlight and return to diff' : 'Clear line highlight'}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
          {active && (
            <button
              type="button"
              className="kt-fs-icon-button"
              data-active={rawActive || undefined}
              aria-pressed={rawActive}
              onClick={() => setActiveView(rawActive ? 'normal' : 'raw')}
              aria-label={rawActive ? `Show ${active.path} normally` : `Show raw bytes for ${active.path}`}
              title={rawActive ? 'Show normally' : 'Show raw'}
            >
              <Code2 size={17} aria-hidden="true" />
            </button>
          )}
          {active && repo && (
            <button
              type="button"
              className="kt-fs-icon-button"
              data-active={diffActive || undefined}
              aria-pressed={diffActive}
              onClick={() => setActiveView(diffActive ? 'normal' : 'diff')}
              aria-label={diffActive ? `Show ${active.path} normally` : `Show git diff for ${active.path}`}
              title={diffActive ? 'Show file' : 'Show git diff'}
            >
              <GitCompareArrows size={17} aria-hidden="true" />
            </button>
          )}
          <ReloadAction
            what={active ? active.path : 'files'}
            busy={shown.refreshing || probe.refreshing}
            onReload={reload}
          />
        </span>
      </div>

      {/* Handover #6's one shared control has a Files mount too.  It keeps its
          query and current-session results with the top bar and Tasks rather
          than becoming a second, path-only filter. */}
      <div className="border-b border-border-soft p-2">
        <SessionSearchControl />
      </div>

      {/* The host's strip is the ONE strip when it owns the opens (#35). */}
      {!hostOwnsTabs && tabs.length > 0 && (
        <OpenFileTabs tabs={tabs} activePath={activePath} onActivate={setActivePath} onClose={closeFile} />
      )}

      {/* Directly above the content it is about, and OUTSIDE the scroller: the
          reading position is part of what a reload preserves. */}
      <StaleNotice dismissible what={shownWhat} status={shown} onRetry={reload} />

      <div className="kt-fs-body">
        {treeOpen && (
          // Mounted (hidden) while a file is open, so expansion and the loaded
          // listings survive a read-then-back round trip. Keyed by the daemon
          // scope so a connection switch rebuilds it rather than reusing one
          // daemon's expanded folders against another's tree.
          <FileTree
            key={key}
            daemon={daemon}
            scope={scope}
            dir={dir}
            refreshNonce={treeRefresh}
            hidden={!!active}
            onEnter={setDir}
            onOpenFile={openFile}
          />
        )}
        <div ref={paneRef} tabIndex={-1} className="kt-fs-scroll scroll-thin outline-none">
          {/* Retained content is checked FIRST here too: the reader keeps the
              bytes and the scroll offset while a reload runs or after it
              fails, exactly as the instance viewer behaves. */}
          {diffActive && active ? (
            // Two answers, not three: a settled successful diff read is never
            // null (`fsApi.diff` resolves a string), so there is no fourth state
            // to describe. Same reasoning as `file-instance-surface.tsx`.
            parsedDiff === null ? (
              diff.error === null ? (
                <Loading what="the diff" />
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
                    Showing the first {parsedDiff.lines.length.toLocaleString()} of {parsedDiff.total.toLocaleString()}{' '}
                    diff lines.
                  </div>
                )}
              </>
            ) : (
              <Note role="status">No textual changes in this file.</Note>
            )
          ) : active ? (
            file.data ? (
              <FileBody
                file={file.data}
                path={active.path}
                raw={rawActive}
                selection={active.selection}
                targetLineRef={targetLineRef}
                markdown={markdown}
                preview={{ daemon, scope, revision: file.revision }}
              />
            ) : file.loading ? (
              <Loading what={baseName(active.path)} />
            ) : file.error ? (
              <Failed what={baseName(active.path)} error={file.error} onRetry={file.reload} />
            ) : (
              <Note role="status">Nothing to show.</Note>
            )
          ) : // "Files still browse normally" is a CLAIM, so it is made only where the listing beside it
          // proves it. Stated unconditionally it contradicted the failure panel underneath it, and a
          // reader had no way to tell which of the two to believe.
          listing.data ? (
            <>
              {probe.state === 'error' && (
                <Note tone="warn" role="status">
                  Files still browse normally, but git change markers are unavailable: {probe.error ?? 'unknown error'}.
                </Note>
              )}
              {changesTruncated && (
                <Note tone="warn" role="status">
                  Some change dots may be missing because the daemon capped this repository’s status response.
                </Note>
              )}
              <BrowseList listing={listing.data} dir={dir} changes={changeMap} onEnter={setDir} onOpenFile={openFile} />
            </>
          ) : listing.loading ? (
            <Loading what={dir || 'the session root'} />
          ) : listing.error ? (
            <Failed what={dir || 'the session root'} error={listing.error} onRetry={listing.reload} />
          ) : (
            <Note role="status">Nothing to show.</Note>
          )}
        </div>
      </div>
    </div>
  );
};
