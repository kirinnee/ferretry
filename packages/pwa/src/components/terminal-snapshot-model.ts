/**
 * The Terminal tab's pure layer: the daemon-scoped snapshot read and the two
 * freshness strings its header prints.
 *
 * The original (`ui/src/components/TerminalView.tsx`) reached a page-global
 * `api.snapshot(sessionId, false)`. There is no page-global daemon here: a
 * session id reused across two paired daemons must never resolve to whichever
 * one happens to be selected, so the read takes an explicit `(daemon, scope)`
 * pair and refuses a scope that belongs to a different daemon.
 */

import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { daemonRequest } from '../lib/daemon-transport.ts';
import { browserFetch, DaemonResponseError, type DaemonFetch } from '../lib/runtime-models.ts';

/**
 * `live=false` is the original's choice and the reason the header says
 * "cached": the tab shows the snapshot the daemon already holds rather than
 * making every reader poll force a live capture off the pane.
 */
export const snapshotUrl = (scope: DaemonSessionScope, live = false): string =>
  `/v1/sessions/${encodeURIComponent(scope.sessionId)}/snapshot?live=${live ? 'true' : 'false'}`;

const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Reads one pane snapshot from the daemon that owns the session. */
export const readPaneSnapshot = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal?: AbortSignal,
  fetcher: DaemonFetch = browserFetch,
): Promise<string> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('terminal scope must belong to the requested daemon');
  const target = daemonRequest(daemon, snapshotUrl(scope), { signal });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) throw await failure(response);
  return await response.text();
};

/** How the daemon's unreachability is worded when the last good text is kept. */
export const describeSnapshotError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * "<1s" / "12s" / "3m 4s", exactly as the original — the unit never collapses
 * to bare minutes, so a reader can tell 3m 1s from 3m 59s.
 */
export const formatSnapshotAge = (ms: number): string => {
  const clamped = ms < 0 ? 0 : ms;
  if (clamped < 1_000) return '<1s';
  const seconds = Math.floor(clamped / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** The absolute wall clock behind the header's `title`, or '' for a bad instant. */
export const formatSnapshotClock = (at: number): string => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** True once the reader is close enough to the end for the pane to stay pinned. */
export const isPinnedToBottom = (scrollHeight: number, scrollTop: number, clientHeight: number): boolean =>
  // 4px of slop covers sub-pixel rounding when content height matches the
  // viewport exactly.
  scrollHeight - scrollTop - clientHeight < 4;
