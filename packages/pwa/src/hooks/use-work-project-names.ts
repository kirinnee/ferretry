/**
 * THE NAMES OF A MACHINE'S PROJECTS, for labelling the cards the work search finds. A hit carries only its
 * project's id (a UUID, or `unfiled`), which no reader can use; the name comes from the board projects the
 * app already reads (`GET /v1/board/projects`), joined only while `active` so a surface that cannot search
 * adds no request.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BoardProjectsState } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { useOptionalAppStore } from '../lib/store.tsx';
import { workProjectNames } from '../lib/work-search.ts';

const NEVER: BoardProjectsState = { status: 'idle', error: null, projects: null, served: false };
const noSubscription = () => () => undefined;

export function useWorkProjectNames(
  daemon: DaemonConnection | undefined,
  active: boolean,
): ReadonlyMap<string, string> {
  const board = useOptionalAppStore()?.board;
  const daemonId = daemon?.daemonId;
  const baseUrl = daemon?.baseUrl;
  const deviceId = daemon?.deviceId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing's facts are the deliberate key
  useEffect(() => {
    if (board === undefined || daemon === undefined || !active) return;
    return board.watchProjects(daemon);
  }, [board, daemonId, baseUrl, deviceId, active]);

  const snapshot = () => (board === undefined || daemonId === undefined ? NEVER : board.projectsState(daemonId));
  const state = useSyncExternalStore(board?.subscribe ?? noSubscription, snapshot, snapshot);
  return useMemo(() => workProjectNames(state.projects ?? []), [state.projects]);
}
