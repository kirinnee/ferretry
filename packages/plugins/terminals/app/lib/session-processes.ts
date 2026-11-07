/**
 * A ferret's processes, read from and stopped on the daemon that owns it (the wire is `protocol/session-processes.ts`).
 * Every answer is parsed before use, and every call rides the shell's per-daemon client: a ferret id reused across two
 * daemons never resolves to whichever is current, because a half is built for one daemon.
 */

import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { grantRefusalNotice } from './grant-notice.ts';
import {
  type SessionProcess,
  SessionProcessIdSchema,
  type SessionProcessList,
  SessionProcessListSchema,
  type SessionProcessOutput,
  SessionProcessOutputSchema,
  type SessionProcessStopResult,
  SessionProcessStopResultSchema,
} from './protocol/session-processes.ts';
import type { TerminalScope } from './web-terminals.ts';

/** What a 403 means to the reader: the grant is the answer, in the words the brief fixes. */
export const PROCESSES_FORBIDDEN_TEXT =
  'This device can’t see this ferret’s processes. Allow Terminals for it in Settings › Devices.';

/** What a 409 `process_changed` means to the reader. */
export const PROCESS_CHANGED_TEXT = 'That process already ended or was replaced — nothing was stopped.';

const PROCESS_ROUTES = {
  list: 'GET /v1/ferrets/:ferretId/processes',
  output: 'GET /v1/ferrets/:ferretId/processes/:processId/output',
  stop: 'POST /v1/ferrets/:ferretId/processes/:processId/stop',
} as const;

const mismatch = (message: string): DaemonCallError => new DaemonCallError(502, 'daemon_mismatch', message);

const processParams = (scope: TerminalScope, processId: string) => ({
  ferretId: scope.sessionId,
  processId: SessionProcessIdSchema.parse(processId),
});

/** Lists the processes under one ferret's pane. */
export const listSessionProcesses = async (client: PluginClient, scope: TerminalScope): Promise<SessionProcessList> => {
  const list = SessionProcessListSchema.parse(
    await client.call(PROCESS_ROUTES.list, { params: { ferretId: scope.sessionId } }),
  );
  if (list.sessionId !== scope.sessionId) throw mismatch('daemon listed another session');
  return list;
};

/**
 * Reads one process's output: the tail with no `after`, or whatever was written since `after`. The
 * `after` is a byte offset the previous answer's `end` supplied, so it is built here as digits only.
 */
export const readSessionProcessOutput = async (
  client: PluginClient,
  scope: TerminalScope,
  processId: string,
  after: number | undefined,
): Promise<SessionProcessOutput> => {
  const output = SessionProcessOutputSchema.parse(
    await client.call(PROCESS_ROUTES.output, {
      params: processParams(scope, processId),
      ...(after === undefined ? {} : { query: { after: String(Math.max(0, Math.trunc(after))) } }),
    }),
  );
  if (output.processId !== processId) throw mismatch('daemon read another process');
  return output;
};

/** Asks the daemon to stop one process and everything it started (SIGTERM). */
export const stopSessionProcess = async (
  client: PluginClient,
  scope: TerminalScope,
  processId: string,
): Promise<SessionProcessStopResult> => {
  const stopped = SessionProcessStopResultSchema.parse(
    await client.call(PROCESS_ROUTES.stop, { params: processParams(scope, processId) }),
  );
  if (stopped.processId !== processId) throw mismatch('daemon stopped another process');
  return stopped;
};

/** A failure, in the words the reader should see: the 403 copy, the changed-process copy, else the daemon's. */
export const processErrorText = (error: unknown): string => {
  if (error instanceof DaemonCallError) {
    if (error.status === 403) return PROCESSES_FORBIDDEN_TEXT;
    if (error.status === 409 && error.code === 'process_changed') return PROCESS_CHANGED_TEXT;
  }
  const grant = grantRefusalNotice(error);
  if (grant !== null) return PROCESSES_FORBIDDEN_TEXT;
  return error instanceof Error ? error.message : String(error);
};

export const isForbidden = (error: unknown): boolean =>
  (error instanceof DaemonCallError && error.status === 403) || grantRefusalNotice(error) !== null;

/** The command as the agent wrote it when there is one. */
export const processTitle = (entry: SessionProcess): string => entry.label ?? entry.command;

type ProcessGroupKey = SessionProcess['kind'] | 'ended';

/** One top-level entry with the processes it started, in the order the list shows them. */
export interface ProcessRow {
  readonly process: SessionProcess;
  readonly children: readonly SessionProcess[];
}

export interface ProcessGroup {
  readonly key: ProcessGroupKey;
  readonly heading: string;
  readonly rows: readonly ProcessRow[];
}

const GROUP_ORDER: readonly SessionProcess['kind'][] = ['command', 'background', 'server', 'helper'];

const GROUP_HEADING: Record<ProcessGroupKey, string> = {
  command: 'Running commands',
  background: 'Background',
  server: 'Servers',
  helper: 'Helpers',
  ended: 'Recently ended',
};

/**
 * What the tab's count is: live, top-level entries that are not helpers — what the person started or
 * cares about. Helpers (the ferret's own MCP servers) always run, and children (renderers, test workers)
 * would inflate the number, so either would keep "Processes · N" from ever being quiet.
 */
export const liveProcessCount = (list: SessionProcessList | null): number => {
  if (list === null) return 0;
  const listed = new Set(list.processes.map(entry => entry.id));
  return list.processes.filter(
    entry =>
      entry.state !== 'exited' &&
      entry.kind !== 'helper' &&
      (entry.parentId === undefined || !listed.has(entry.parentId)),
  ).length;
};

/**
 * Groups a list for display: command, background, server, helper, then the exited under "Recently ended".
 * A process whose parent is listed rides under that parent; one whose parent is not listed is top level.
 * The daemon already sends parents before children and oldest first, and that order is kept inside a group.
 */
export const groupProcesses = (list: SessionProcessList): readonly ProcessGroup[] => {
  const byId = new Map(list.processes.map(entry => [entry.id, entry] as const));
  const childrenOf = new Map<string, SessionProcess[]>();
  const top: SessionProcess[] = [];
  for (const entry of list.processes) {
    const parent = entry.parentId === undefined ? undefined : byId.get(entry.parentId);
    if (parent === undefined) {
      top.push(entry);
    } else {
      const siblings = childrenOf.get(parent.id);
      if (siblings === undefined) childrenOf.set(parent.id, [entry]);
      else siblings.push(entry);
    }
  }
  const descendants = (entry: SessionProcess): readonly SessionProcess[] =>
    (childrenOf.get(entry.id) ?? []).flatMap(child => [child, ...descendants(child)]);
  const rowOf = (entry: SessionProcess): ProcessRow => ({ process: entry, children: descendants(entry) });
  const groups: ProcessGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const rows = top.filter(entry => entry.state !== 'exited' && entry.kind === kind).map(rowOf);
    if (rows.length > 0) groups.push({ key: kind, heading: GROUP_HEADING[kind], rows });
  }
  const ended = top.filter(entry => entry.state === 'exited').map(rowOf);
  if (ended.length > 0) groups.push({ key: 'ended', heading: GROUP_HEADING.ended, rows: ended });
  return groups;
};

/** "2m 14s", "45s", "1h 05m", "3d 4h": the two largest units, never more. */
export const formatElapsed = (milliseconds: number): string => {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  if (total < 60) return `${String(total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(total % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
};

/** "2m 14s" while it runs; "ended 3m ago" (plus the exit code when it is known) once it has. */
export const processElapsedText = (entry: SessionProcess, now: number): string => {
  if (entry.state !== 'exited') return formatElapsed(now - Date.parse(entry.startedAt));
  const ended = entry.endedAt === undefined ? '' : `ended ${formatElapsed(now - Date.parse(entry.endedAt))} ago`;
  const code = entry.exit?.code === undefined ? '' : `exit ${String(entry.exit.code)}`;
  return [ended, code].filter(part => part !== '').join(' · ') || 'ended';
};

export const formatMemory = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
