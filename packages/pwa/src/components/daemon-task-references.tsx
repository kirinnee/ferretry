/**
 * `&F12` ON A SURFACE THAT IS NOT A CHAT: the Inbox and the Board's card detail have no session, so no
 * `ReferenceSurfaceProvider` above them and their `&` text would stay prose.
 *
 * This supplies the SAME two things a chat supplies for a task — the proof (every card id on this machine,
 * from the board store's one read) and the open (this machine's card route) — and nothing else, so a task
 * reference reads, proves and clicks the same everywhere. A surface already above wins: a chat's richer one
 * is never downgraded, so wrapping a surface that may sit in a chat is always safe.
 */

import { type ReactNode, useMemo } from 'react';

import { useMachineTaskIds } from '../hooks/use-machine-task-ids.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonBoardCardPath } from '../lib/pages/routes.ts';
import { useOptionalAppStore } from '../lib/store.tsx';
import { createTaskReferenceResolver } from '../lib/task-reference-context.tsx';
import { ReferenceSurfaceProvider, useReferenceSurface } from './reference-surface.tsx';

export function DaemonTaskReferences({
  connection,
  onNavigate,
  store,
  children,
}: {
  readonly connection: DaemonConnection | undefined;
  readonly onNavigate: (to: string) => void;
  /** The board store; the app's own when omitted. */
  readonly store?: DaemonBoardStore | undefined;
  readonly children: ReactNode;
}) {
  const outer = useReferenceSurface();
  const appStore = useOptionalAppStore();
  const board = store ?? appStore?.board;
  const ids = useMachineTaskIds(board, connection);
  const daemonId = connection?.daemonId;
  const surface = useMemo(
    () =>
      ids === undefined || daemonId === undefined
        ? outer
        : {
            ...outer,
            taskReferenceResolver: createTaskReferenceResolver([], ids),
            onTaskOpen: (written: string) => onNavigate(daemonBoardCardPath(daemonId, written.toUpperCase())),
          },
    [outer, ids, daemonId, onNavigate],
  );
  if (outer.taskReferenceResolver !== undefined) return <>{children}</>;
  return <ReferenceSurfaceProvider surface={surface}>{children}</ReferenceSurfaceProvider>;
}
