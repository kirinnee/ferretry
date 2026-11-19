import { useCallback, useMemo } from 'react';
import { findLine, type ParsedPatch, parsePatch } from '../../../contract/diff-hunks.ts';
import type { PullDetail, PullFile } from '../../../contract/index.ts';
import { type LineExtras, PullFilesView } from '../diff/index.ts';
import { usePullFiles } from '../diff/use-pull-files.ts';
import { OutdatedThreads, placeThreads, ThreadCard, threadsAt, useThreads } from '../threads/index.ts';
import type { DiffRows } from '../threads/index.ts';
import type { PullAddress, PullsClient } from './api.ts';
import { DiffSelectionScope } from './scopes.tsx';
import { ReplyBox } from './reply-box.tsx';

/** Which rows the files' hunks draw: asked of the parser E5 owns, one file's patch read once and only when asked. */
function rowsOf(files: readonly PullFile[]): DiffRows {
  const patches = new Map(files.map(file => [file.path, file.patch] as const));
  const parsed = new Map<string, ParsedPatch | undefined>();
  return {
    hasLine(path, side, line) {
      if (!parsed.has(path)) {
        const patch = patches.get(path);
        parsed.set(path, patch === undefined ? undefined : parsePatch(patch));
      }
      const hunks = parsed.get(path);
      return hunks !== undefined && findLine(hunks, side, line) !== undefined;
    },
  };
}

/**
 * The Files tab with its review threads and its ways to write: the diff (E5), the threads drawn under their lines (E6) with
 * a **Reply** under each, and a selection of diff lines that offers **Quote** and **Comment on these lines** (E7). The
 * threads are placed only once the files are known, so a thread is drawn once, where it belongs, and never moves.
 */
export function ReviewableFiles({
  client,
  daemon,
  address,
  pull,
}: {
  readonly client: PullsClient;
  readonly daemon: string;
  readonly address: PullAddress;
  readonly pull: PullDetail;
}) {
  // A second, conditional read of the same files (a `304` for the daemon): the thread placement needs the hunks' rows.
  const files = usePullFiles(client, address.project, address, address.number).state;
  const threads = useThreads(client, { ...address, updatedAt: pull.updatedAt });
  const placement = useMemo(() => {
    if (files.status !== 'ready') return undefined;
    const known =
      threads.status === 'ready' ? threads.answer : threads.status === 'failed' ? threads.answer : undefined;
    return known === undefined ? undefined : placeThreads(known.threads, rowsOf(files.answer.files));
  }, [files, threads]);

  const lineExtras = useCallback<LineExtras>(
    at => {
      const here = placement === undefined ? [] : threadsAt(placement, at.path, at.side, at.line);
      if (here.length === 0) return null;
      return (
        <div
          className="grid gap-sm px-sm py-xs font-ui"
          data-compose-extras=""
          data-line-threads={`${at.path}:${at.side}:${String(at.line)}`}
        >
          {here.map(thread => (
            <div className="grid gap-xs" key={thread.id}>
              <ThreadCard thread={thread} />
              <ReplyBox thread={thread} />
            </div>
          ))}
        </div>
      );
    },
    [placement],
  );

  return (
    <div className="grid min-w-0 gap-sm">
      {threads.status === 'failed' && (
        <p className="m-0 text-meta text-warn" data-threads-failed="" role="status">
          The review threads could not be read: {threads.message}
        </p>
      )}
      <DiffSelectionScope>
        <PullFilesView
          client={client}
          daemon={daemon}
          lineExtras={lineExtras}
          number={address.number}
          project={address.project}
          repo={{ provider: 'github', owner: address.owner, name: address.name }}
        />
      </DiffSelectionScope>
      {placement !== undefined && (
        <div data-compose-extras="">
          <OutdatedThreads placement={placement} />
        </div>
      )}
    </div>
  );
}
