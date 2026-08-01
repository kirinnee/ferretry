import { FileText, Folder, Link2Off, Loader2, Lock, RefreshCw, ChevronRight } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { describeFsError, fsApi, isAbort } from './files-api.ts';
import { formatBytes } from './files-model.ts';
import {
  createFileTreeState,
  invalidateTree,
  markTreeDirLoading,
  pendingTreeDirs,
  resetTreeDir,
  revealTreeDir,
  setTreeDirError,
  setTreeDirListing,
  toggleTreeDir,
  treeRows,
  type TreeRow,
} from './file-tree-model.ts';

const depthStyle = (depth: number): CSSProperties => ({ '--kt-fs-tree-depth': depth }) as CSSProperties;
export interface FileTreeRowsProps {
  rows: readonly TreeRow[];
  onToggle(path: string): void;
  onEnter(path: string): void;
  onOpenFile(path: string): void;
  onRetry(dir: string): void;
}
export const FileTreeRows = ({ rows, onToggle, onEnter, onOpenFile, onRetry }: FileTreeRowsProps) => (
  <ul className="m-0 list-none p-0">
    {rows.map(row => {
      if (row.kind === 'note')
        return (
          <li key={`${row.note}:${row.dir}`}>
            <div
              className="kt-fs-tree-note"
              data-tone={row.note === 'error' ? 'err' : undefined}
              role={row.note === 'error' ? 'alert' : 'status'}
              style={depthStyle(row.depth)}
            >
              {row.note === 'loading' ? (
                <>
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  Loading…
                </>
              ) : row.note === 'error' ? (
                <>
                  <span>
                    Could not list {row.dir || 'the session root'}: {row.error}
                  </span>
                  <button
                    type="button"
                    className="kt-btn kt-btn--sm kt-fs-retry"
                    onClick={() => onRetry(row.dir)}
                    aria-label={`Retry listing ${row.dir || 'the session root'}`}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    Retry
                  </button>
                </>
              ) : row.note === 'empty' ? (
                'Empty.'
              ) : (
                'Listing truncated by the daemon.'
              )}
            </div>
          </li>
        );
      const icon = row.refusal?.includes('leaves') ? (
        <Link2Off size={14} className="kt-fs-icon" aria-hidden="true" />
      ) : row.refusal ? (
        <Lock size={14} className="kt-fs-icon" aria-hidden="true" />
      ) : row.kind === 'dir' ? (
        <Folder size={14} className="kt-fs-icon" aria-hidden="true" />
      ) : (
        <FileText size={14} className="kt-fs-icon" aria-hidden="true" />
      );
      if (row.refusal)
        return (
          <li key={`${row.kind}:${row.path}`}>
            <div
              className="kt-fs-tree-row"
              data-kind={row.kind}
              data-inert="true"
              style={depthStyle(row.depth)}
              title={row.refusal}
            >
              {icon}
              <span className="kt-fs-tree-name">
                {row.name}
                {row.kind === 'dir' ? '/' : ''}
              </span>
            </div>
          </li>
        );
      if (row.kind === 'dir')
        return (
          <li key={`dir:${row.path}`}>
            <div
              className="kt-fs-tree-row"
              data-kind="dir"
              data-selected={row.selected || undefined}
              style={depthStyle(row.depth)}
            >
              <button
                type="button"
                className="kt-fs-tree-toggle"
                aria-expanded={row.expanded}
                onClick={() => onToggle(row.path)}
                aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.path}`}
                title={row.expanded ? 'Collapse' : 'Expand'}
              >
                <ChevronRight
                  size={14}
                  className={row.expanded ? 'rotate-90 transition-transform' : 'transition-transform'}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                className="kt-fs-tree-open"
                aria-current={row.selected ? 'location' : undefined}
                onClick={() => onEnter(row.path)}
                aria-label={`Go to folder ${row.path}`}
                title={row.path}
              >
                {icon}
                <span className="kt-fs-tree-name">{row.name}/</span>
              </button>
            </div>
          </li>
        );
      return (
        <li key={`file:${row.path}`}>
          <div className="kt-fs-tree-row" data-kind="file" style={depthStyle(row.depth)}>
            <button
              type="button"
              className="kt-fs-tree-open"
              onClick={() => onOpenFile(row.path)}
              aria-label={`Open file ${row.path}${row.size != null ? `, ${formatBytes(row.size)}` : ''}`}
              title={row.path}
            >
              {icon}
              <span className="kt-fs-tree-name">{row.name}</span>
            </button>
          </div>
        </li>
      );
    })}
  </ul>
);

export interface FileTreeProps {
  daemon: DaemonConnection;
  scope: DaemonSessionScope;
  dir: string;
  refreshNonce?: number;
  hidden?: boolean;
  onEnter(path: string): void;
  onOpenFile(path: string): void;
}
export const FileTree = ({ daemon, scope, dir, refreshNonce = 0, hidden, onEnter, onOpenFile }: FileTreeProps) => {
  const [state, setState] = useState(createFileTreeState);
  const inflight = useRef(new Map<string, AbortController>());
  useEffect(() => {
    setState(current => revealTreeDir(current, dir));
  }, [dir]);
  useEffect(() => {
    if (!refreshNonce) return;
    for (const controller of inflight.current.values()) controller.abort();
    inflight.current.clear();
    setState(invalidateTree);
  }, [refreshNonce]);
  useEffect(() => {
    for (const pendingDir of pendingTreeDirs(state)) {
      if (inflight.current.has(pendingDir)) continue;
      const controller = new AbortController();
      inflight.current.set(pendingDir, controller);
      setState(current => markTreeDirLoading(current, pendingDir));
      void fsApi
        .list(daemon, scope, pendingDir, controller.signal)
        .then(listing => {
          if (!controller.signal.aborted) setState(current => setTreeDirListing(current, pendingDir, listing));
        })
        .catch(error => {
          if (!controller.signal.aborted && !isAbort(error))
            setState(current => setTreeDirError(current, pendingDir, describeFsError(error)));
        })
        .finally(() => {
          if (inflight.current.get(pendingDir) === controller) inflight.current.delete(pendingDir);
        });
    }
  }, [daemon, scope, state]);
  useEffect(
    () => () => {
      for (const controller of inflight.current.values()) controller.abort();
    },
    [],
  );
  return (
    <nav className="kt-fs-tree scroll-thin" aria-label="Folder tree" hidden={hidden || undefined}>
      <FileTreeRows
        rows={treeRows(state, dir)}
        onToggle={path => setState(current => toggleTreeDir(current, path))}
        onEnter={onEnter}
        onOpenFile={onOpenFile}
        onRetry={retryDir => setState(current => resetTreeDir(current, retryDir))}
      />
    </nav>
  );
};
