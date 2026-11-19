import { Button, Loading } from '@ferretry/app/ui';
import { useCallback, useMemo, useState } from 'react';
import type { PullFile, RepoRef } from '../../../contract/index.ts';
import { DiffFile, fileAnchor } from './diff-file.tsx';
import type { LineExtras } from './diff-rows.tsx';
import { FileTree } from './file-tree.tsx';
import { type PullsClient, usePullFiles } from './use-pull-files.ts';
import { useViewedTicks } from './use-viewed.ts';
import { useWide } from './use-wide.ts';

export interface PullFilesViewProps {
  readonly client: PullsClient;
  /** The project's id (a daemon-local uuid). */
  readonly project: string;
  readonly repo: RepoRef;
  readonly number: number;
  /** Tells the viewed ticks apart per machine; two daemons can hold the same project id. */
  readonly daemon?: string;
  /** Draws review threads under a line (E6). Absent: the diff has none. */
  readonly lineExtras?: LineExtras;
}

/**
 * The Files tab of a pull request: a filterable tree of the changed files and their diffs, one column below 1024 px and
 * split from there. The PR page (E4) mounts it; nothing here knows the page it sits in.
 */
export function PullFilesView({
  client,
  project,
  repo,
  number,
  daemon = 'this-daemon',
  lineExtras,
}: PullFilesViewProps) {
  const { state, reload } = usePullFiles(client, project, repo, number);
  const wide = useWide();
  const [unified, setUnified] = useState(false);
  const files = state.status === 'ready' ? state.answer.files : [];
  const ticks = useViewedTicks(`${daemon}.${project}.${repo.owner}.${repo.name}.${number}`);
  const pick = useCallback((path: string) => {
    const target = document.getElementById(fileAnchor(path));
    target?.scrollIntoView({ block: 'start' });
    target?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, []);
  const total = useMemo(
    () =>
      files.reduce((sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }), {
        add: 0,
        del: 0,
      }),
    [files],
  );
  const [treeOpen, setTreeOpen] = useState(false);

  if (state.status === 'loading') return <Loading kind="page" label="Loading the changed files…" />;
  if (state.status === 'failed')
    return (
      <div className="grid justify-items-start gap-sm" data-pulls-files="failed" role="alert">
        <p className="m-0 text-cell text-err">{state.message}</p>
        <Button onClick={reload} size="sm">
          Try again
        </Button>
      </div>
    );
  if (files.length === 0)
    return (
      <p className="m-0 text-cell text-muted" data-pulls-files="empty">
        This pull request changes no files.
      </p>
    );

  const split = wide && !unified;
  const viewed = (file: PullFile): boolean => ticks.isViewed(file);
  return (
    <div className="grid min-w-0 gap-sm" data-pulls-files="ready">
      <div className="flex flex-wrap items-center gap-sm text-meta text-muted">
        <span>
          {files.length} files changed <span className="text-ok">+{total.add}</span>{' '}
          <span className="text-err">−{total.del}</span>
        </span>
        <span aria-live="polite">
          {files.filter(viewed).length} of {files.length} viewed
        </span>
        <span className="flex items-center gap-xs">
          {wide ? (
            <Button aria-pressed={unified} onClick={() => setUnified(value => !value)} size="sm">
              {unified ? 'Split view' : 'Unified view'}
            </Button>
          ) : (
            <Button aria-expanded={treeOpen} onClick={() => setTreeOpen(value => !value)} size="sm">
              {treeOpen ? 'Hide file list' : 'File list'}
            </Button>
          )}
          <Button onClick={reload} size="sm">
            Refresh
          </Button>
        </span>
      </div>
      {state.answer.truncated ? (
        <p className="m-0 text-meta text-warn" role="status">
          GitHub lists at most 3000 files, so some are not shown here.
        </p>
      ) : null}
      {state.answer.unreadable > 0 ? (
        <p className="m-0 text-meta text-warn" role="status">
          {state.answer.unreadable} files could not be read and are left out.
        </p>
      ) : null}
      <div className={wide ? 'grid min-w-0 grid-cols-[18rem_minmax(0,1fr)] items-start gap-md' : 'grid min-w-0 gap-sm'}>
        {wide || treeOpen ? (
          <div className={wide ? 'sticky top-0 self-start' : ''}>
            <FileTree
              files={files}
              onPick={path => {
                pick(path);
                setTreeOpen(false);
              }}
              viewed={viewed}
            />
          </div>
        ) : null}
        <div className="grid min-w-0 gap-sm">
          {files.map(file => (
            <DiffFile
              extras={lineExtras}
              file={file}
              key={file.path}
              onViewed={value => ticks.setViewed(file, value)}
              split={split}
              viewed={viewed(file)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
