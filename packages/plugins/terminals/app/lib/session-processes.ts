/**
 * A ferret's processes, read from and stopped on the daemon that owns it (`docs`-free: the wire contract
 * is `@ferretry/protocol` `session-processes.ts`). Every answer is parsed before use, and every call is
 * addressed to one paired daemon — a session id reused across two daemons never resolves to whichever is
 * current.
 */

import { DaemonCallError, FY_REQUEST_ID_HEADER } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
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
import { assertScopeDaemon, type DaemonConnection, type DaemonSessionScope, grantRefusalNotice } from '../shell.ts';

/** What a 403 means to the reader: the grant is the answer, in the words the brief fixes. */
export const PROCESSES_FORBIDDEN_TEXT =
  'This device can’t see this ferret’s processes. Allow Terminals for it in Settings › Devices.';

/** What a 409 `process_changed` means to the reader. */
export const PROCESS_CHANGED_TEXT = 'That process already ended or was replaced — nothing was stopped.';

/** What every process call needs of the shell's per-daemon client: a route by its manifest key. */
export type ProcessCalls = Pick<PluginClient, 'call'>;

/** The process routes, by manifest key. */
export const PROCESS_ROUTES = {
  list: 'GET /v1/ferrets/:ferretId/processes',
  output: 'GET /v1/ferrets/:ferretId/processes/:processId/output',
  stop: 'POST /v1/ferrets/:ferretId/processes/:processId/stop',
} as const;

const mismatch = (message: string): DaemonCallError => new DaemonCallError(502, 'daemon_mismatch', message);

/** A read that was cancelled while it was in flight answers as the cancel, not as the daemon's answer. */
const settled = <T>(value: T, signal: AbortSignal | undefined): T => {
  signal?.throwIfAborted();
  return value;
};

/** Lists the processes under one session's pane. */
export const listSessionProcesses = async (
  client: ProcessCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  signal?: AbortSignal,
): Promise<SessionProcessList> => {
  assertScopeDaemon(daemon, scope);
  signal?.throwIfAborted();
  const list = SessionProcessListSchema.parse(
    settled(await client.call(PROCESS_ROUTES.list, { params: { ferretId: scope.sessionId } }), signal),
  );
  if (list.sessionId !== scope.sessionId) throw mismatch('daemon listed another session');
  return list;
};

/**
 * Reads one process's output: the tail with no `after`, or whatever was written since `after`. The
 * `after` is a byte offset the previous answer's `end` supplied, so it is built here as digits only.
 */
export const readSessionProcessOutput = async (
  client: ProcessCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  processId: string,
  after: number | undefined,
  signal?: AbortSignal,
): Promise<SessionProcessOutput> => {
  assertScopeDaemon(daemon, scope);
  signal?.throwIfAborted();
  const params = { ferretId: scope.sessionId, processId: SessionProcessIdSchema.parse(processId) };
  const query: Record<string, string> = after === undefined ? {} : { after: String(Math.max(0, Math.trunc(after))) };
  const output = SessionProcessOutputSchema.parse(
    settled(await client.call(PROCESS_ROUTES.output, { params, query }), signal),
  );
  if (output.processId !== processId) throw mismatch('daemon read another process');
  return output;
};

/** Asks the daemon to stop one process and everything it started (SIGTERM). */
export const stopSessionProcess = async (
  client: ProcessCalls,
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  processId: string,
): Promise<SessionProcessStopResult> => {
  assertScopeDaemon(daemon, scope);
  const stopped = SessionProcessStopResultSchema.parse(
    await client.call(PROCESS_ROUTES.stop, {
      params: { ferretId: scope.sessionId, processId: SessionProcessIdSchema.parse(processId) },
      headers: { [FY_REQUEST_ID_HEADER]: crypto.randomUUID() } as { readonly 'x-fy-request-id': string },
    }),
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

/** The command as the agent wrote it when there is one. */
export const processTitle = (entry: SessionProcess): string => entry.label ?? entry.command;

type ProcessGroupKey = SessionProcess['kind'] | 'ended';

/** One top-level entry with the processes it started, in the order the list shows them. */
interface ProcessRow {
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

// ── Following one process's output ─────────────────────────────────────────────────────────────────────────────────

/** The most output text held for one process; older text is dropped, and the pane says so. */
export const PROCESS_OUTPUT_HELD_MAX = 2 * 1024 * 1024;

/** What a pane holds of one process's output while it follows it. */
export interface HeldOutput {
  readonly text: string;
  /** The byte the next read asks after: the last answer's `end`. Absent before the first answer. */
  readonly end: number | undefined;
  /** Text before what is held exists and is not shown. */
  readonly skipped: boolean;
  readonly source: SessionProcessOutput['source'] | undefined;
  readonly reason: string | undefined;
  /** Nothing more will be written. */
  readonly complete: boolean;
}

export const EMPTY_OUTPUT: HeldOutput = {
  text: '',
  end: undefined,
  skipped: false,
  source: undefined,
  reason: undefined,
  complete: false,
};

/**
 * Folds one answer into what is held — the whole of the follow bookkeeping, kept pure so it is tested
 * without a clock:
 *
 *  - the first answer (no `end` held) is the tail, and says whether earlier text exists;
 *  - `reset` means the file was replaced or truncated: what is held is dropped and the answer stands alone;
 *  - `skipped` after the first read means the gap was larger than one read: what is held no longer
 *    touches the new text, so it is dropped and the pane says "earlier output not shown";
 *  - otherwise the answer continues what is held, which is capped at {@link PROCESS_OUTPUT_HELD_MAX}.
 */
export const applyOutput = (held: HeldOutput, answer: SessionProcessOutput): HeldOutput => {
  const base = { end: answer.end, source: answer.source, reason: answer.reason, complete: answer.complete };
  if (held.end === undefined || answer.reset || answer.skipped) {
    return { ...base, text: answer.text, skipped: answer.skipped };
  }
  const joined = held.text + answer.text;
  if (joined.length <= PROCESS_OUTPUT_HELD_MAX) return { ...base, text: joined, skipped: held.skipped };
  return { ...base, text: joined.slice(joined.length - PROCESS_OUTPUT_HELD_MAX), skipped: true };
};
