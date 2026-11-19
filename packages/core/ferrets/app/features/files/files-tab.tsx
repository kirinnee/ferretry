/**
 * The Files tab — a deliberately ordinary read-only file browser for ONE
 * ferret on ONE paired daemon. Ported from `ui/src/components/FilesTab.tsx`.
 *
 * ONE bar carries the path and the actions. Browsing: tree toggle, breadcrumbs,
 * Reload. Viewing: back, the file's path, and its view actions. The original's
 * standalone breadcrumb rail is gone on purpose — the crumbs ARE the bar's path
 * segment.
 *
 * Reload is the same contract the instance viewer honours: the labelled action
 * re-reads from the ferret’s host, what is already on screen stays there while
 * it runs and if it fails, and one notice says which copy is being read.
 *
 * MULTI-DAEMON. Every read is addressed to the daemon passed in, and the
 * remembered open-file tabs are keyed by (the daemon's client, the ferret id)
 * (`files-tab-model.ts`). Switching the connection therefore cannot show one
 * daemon's directory, file bytes, diff or open-tab list under another's name;
 * while the remembered state is still being swapped in, the pane says it is
 * loading rather than painting the previous daemon's tree.
 */

import { ListTree } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanelSlot, useOptionalRouter } from '@ferretry/app';
import { FILES_SEARCH_SLOT, type FilesSearchSlotProps, isOpenablePath } from '@ferretry/core-ferrets/contract';
import { useLayoutMode } from '@ferretry/app/ui';
import { daemonOfRoute } from '../header/header-paths.ts';
import { useFileInstanceSurface } from './file-instance-surface.tsx';
import { FileTree } from './file-tree.tsx';
import { fsApi, useFsProbe } from './files-api.ts';
import { crumbs } from './files-model.ts';
import { ReloadAction, StaleNotice } from './files-reload.tsx';
import { useFsResource } from './files-resource.ts';
import { type FilesScope, scopeKey } from './scope.ts';
import type { FsListing } from './wire.ts';
import {
  type CodeReferenceOpenRequest,
  type ColumnCodeReference,
  type FileLineSelection,
  type FileView,
  filesTreeOpenByDefault,
  type OpenFileTab,
  readFilesTabState,
  selectionFromReference,
  writeFilesTabState,
} from './files-tab-model.ts';
import { BrowseList, Failed, Loading, Note, OpenFileTabs, Unavailable } from './files-views.tsx';

export interface FilesTabProps {
  scope: FilesScope;
  /**
   * The ferret's working directory — the viewer's root, shown as the `root`
   * breadcrumb's title so it is obvious WHICH tree is being read.
   */
  cwd?: string;
  /** Programmatic open request from whichever surface hosts this pane. */
  requestedReference?: CodeReferenceOpenRequest | null;
  onRequestedReferenceHandled?: (sequence: number) => void;
  /**
   * A host that owns a tab strip takes the opens.
   *
   * Handover #35 is one tab per file, and a host that gives every file its own
   * tab must not ALSO have this pane hold a second, competing strip of its own.
   * When this is supplied, the pane is purely the PICKER — the tree, the
   * listing and the breadcrumbs — and every row-open, every code reference and
   * every Markdown file link is handed to the host, which opens the file as its
   * own `file:<path>` tab. No host does yet (the side column has no tab strip: GAP(file-instance)).
   *
   * Without it, the pane keeps its own strip — one tab per file — and draws the
   * file on show through `useFileInstanceSurface` (`file-instance-surface.tsx`).
   */
  onOpenFile?: (path: string, selection?: FileLineSelection) => void;
}

export const FilesTab = ({
  scope,
  cwd,
  requestedReference,
  onRequestedReferenceHandled,
  onOpenFile,
}: FilesTabProps) => {
  const probe = useFsProbe(scope);
  const router = useOptionalRouter();
  const daemon = router === null ? undefined : daemonOfRoute(router.route);
  const layout = useLayoutMode();
  const key = scopeKey(scope);
  const restored = readFilesTabState(scope);
  const [stateKey, setStateKey] = useState(key);
  const [dir, setDir] = useState(restored.dir);
  const [tabs, setTabs] = useState<readonly OpenFileTab[]>(restored.tabs);
  const [activePath, setActivePath] = useState<string | null>(restored.activePath);
  const [treePref, setTreePref] = useState<boolean | undefined>(restored.tree);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [focusRequest, setFocusRequest] = useState(0);
  const handledReference = useRef<number | null>(null);
  // The newest focus request the open file's surface has acted on: activating an EXISTING tab remounts the surface
  // with the same request number and must not pull focus.
  const focusedRequest = useRef(0);
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
    focusedRequest.current = 0;
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

  // A daemon that cannot serve this surface at all is answered ONCE, above. Nothing below is fetched
  // in that state — a listing request would only earn a second panel contradicting the first.
  const unavailable = probe.state === 'unsupported';

  // Opening a file nulls this key and Back re-arms it, so `refetchOnRearm` is
  // what makes Back a fresh read: an agent creates and deletes files while the
  // reader is inside one, and a browse list served from before they opened it
  // would hide exactly that, silently. The file's own bytes below are the
  // opposite case and keep the default.
  const listing = useFsResource<FsListing>(
    stateMatchesScope && !active && !unavailable ? `list:${key}:${dir}` : null,
    useCallback((signal, press) => fsApi.list(scope, dir, signal, press), [scope, dir]),
    { refetchOnRearm: true },
  );

  const instance = useFileInstanceSurface({
    scope,
    tab: unavailable ? null : active,
    repo,
    probeRefreshing: probe.refreshing,
    onReloadProbe: probe.refresh,
    onBack: () => setActivePath(null),
    onViewChange: setActiveView,
    onClearSelection: clearActiveSelection,
    focusRequest,
    focusedRequest,
  });

  if (!stateMatchesScope)
    return (
      <div className="kt-fs rounded-md border border-border bg-surface">
        <Loading what="ferret files" kind="page" />
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

  const treeOpen = filesTreeOpenByDefault(treePref, layout);
  const reload = () => {
    probe.refresh();
    listing.reload();
    setTreeRefresh(nonce => nonce + 1);
  };
  // The tree stays mounted (hidden) while a file is open, so expansion and the loaded
  // listings survive a read-then-back round trip. Keyed by the daemon
  // scope so a connection switch rebuilds it rather than reusing one
  // daemon's expanded folders against another's tree.
  const tree = treeOpen ? (
    <FileTree
      key={key}
      scope={scope}
      dir={dir}
      refreshNonce={treeRefresh}
      hidden={!!active}
      onEnter={setDir}
      onOpenFile={openFile}
    />
  ) : null;
  const strip =
    !hostOwnsTabs && tabs.length > 0 ? (
      <OpenFileTabs tabs={tabs} activePath={activePath} onActivate={setActivePath} onClose={closeFile} />
    ) : null;

  return (
    // `.kt-fs` owns flex:1 + min-height:0 (files.css) — the pane fills what the
    // page gives it and its scroller, not the page, takes the overflow.
    <div className="kt-fs rounded-md border border-border bg-surface">
      {/* The search box is Conversation's, mounted through the slot Ferrets offers; nothing is drawn without it. */}
      {daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          props={{ ferret: scope.ferretId, openFile } satisfies FilesSearchSlotProps}
          slot={FILES_SEARCH_SLOT}
        />
      )}
      {instance === null ? (
        <div className="kt-fs-bar">
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
                  aria-label={index === 0 ? `Go to the ferret’s root${cwd ? ` (${cwd})` : ''}` : `Go to ${crumb.path}`}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
          <span className="kt-fs-actions">
            <ReloadAction what="files" busy={listing.refreshing || probe.refreshing} onReload={reload} />
          </span>
        </div>
      ) : (
        // One open file is its own instance (`file-instance-surface.tsx`).
        instance.bar
      )}

      {/* The host's strip is the ONE strip when it owns the opens (#35). */}
      {strip}

      {/* Directly above the content it is about, and OUTSIDE the scroller: the
          reading position is part of what a reload preserves. */}
      {instance === null ? (
        <StaleNotice dismissible what={dir || 'the ferret’s root'} status={listing} onRetry={reload} />
      ) : (
        instance.notice
      )}

      <div className="kt-fs-body">
        {tree}
        <div ref={instance?.paneRef} tabIndex={-1} className="kt-fs-scroll scroll-thin outline-none">
          {instance !== null ? (
            instance.body
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
          ) : listing.error ? (
            <Failed what={dir || 'the ferret’s root'} error={listing.error} onRetry={listing.reload} />
          ) : (
            <Loading what={dir || 'the ferret’s root'} kind="bar" />
          )}
        </div>
      </div>
    </div>
  );
};
