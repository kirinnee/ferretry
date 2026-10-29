import {
  type SessionProcessKind,
  type SessionProcessOutputAvailability,
  type SessionProcessState,
} from '@ferretry/protocol';
import { classifyPaneProcesses, type PaneProcess, type PaneProcessRole } from '../../warden/pane-processes.ts';
import { claudeTaskId, commandLabel, liveOutputAvailability, outputFileOf } from './commands.ts';
import type { ProcessDetailRow } from './ports.ts';

/**
 * A PANE'S PROCESS TREE AS THE PROCESSES TAB LISTS IT. Pure: no IO, no clock, no globals.
 *
 * Which process is what is the Warden's question too, so the answer is the Warden's
 * ({@link classifyPaneProcesses}): a shell the harness started is a tool command and everything below
 * it is part of that command, unless it listens on a socket (a server) or is a browser; anything else
 * the harness started is a helper it keeps for the session. This file only maps those roles onto the
 * four words a person reads — command, background, server, helper — and says which command the agent
 * did not wait for, which only the transcript knows ({@link ProcessView.backgroundTaskIds}).
 */

/** A process's identity as the wire carries it: pid and start, joined by a dot. */
export function processIdOf(pid: number, start: number): string {
  return `${pid}.${start}`;
}

export function parseProcessId(id: string): { readonly pid: number; readonly start: number } | undefined {
  const match = /^([1-9][0-9]{0,9})\.([0-9]{1,20})$/u.exec(id);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  const start = Number(match[2]);
  return Number.isSafeInteger(pid) && Number.isSafeInteger(start) ? { pid, start } : undefined;
}

/** One listed process before redaction, with what the daemon needs to keep about it. */
export interface ProcessEntry {
  readonly id: string;
  readonly row: ProcessDetailRow;
  readonly parentId?: string;
  readonly label?: string;
  readonly kind: SessionProcessKind;
  readonly state: SessionProcessState;
  readonly output: SessionProcessOutputAvailability;
  /** The regular file its output is read from, when there is one. */
  readonly outputPath?: string;
  /** The Claude Code task id its output file names. */
  readonly taskId?: string;
  /** A top-level tool command — kept for a while after it ends. */
  readonly toolCommand: boolean;
  readonly stoppable: boolean;
}

export interface ProcessView {
  readonly rows: readonly ProcessDetailRow[];
  /** Pids provenance recognised as the harness's own (`kind: 'harness'` is the harness itself). */
  readonly known: ReadonlyMap<number, { readonly kind: string }>;
  readonly listening: ReadonlySet<number>;
  readonly backgroundTaskIds: ReadonlySet<string>;
  readonly nowMs: number;
}

export function stateOf(kernelState: string): SessionProcessState {
  switch (kernelState.charAt(0)) {
    case 'R':
      return 'running';
    case 'T':
    case 't':
      return 'stopped';
    case 'Z':
    case 'X':
      return 'zombie';
    default:
      return 'sleeping';
  }
}

function kindOfRole(role: PaneProcessRole): SessionProcessKind | undefined {
  switch (role) {
    case 'harness':
      return undefined;
    case 'helper':
    case 'browser':
      return 'helper';
    case 'service':
      return 'server';
    case 'command':
      return 'command';
  }
}

/** Every listed process — the harness itself left out — parents before children, each parent's children oldest first. */
export function processEntries(view: ProcessView): readonly ProcessEntry[] {
  const paneProcesses: PaneProcess[] = view.rows.map(row => ({
    pid: row.pid,
    ppid: row.ppid,
    argv: row.argv,
    startedSecondsAgo: Math.max(0, Math.floor((view.nowMs - row.startedAtMs) / 1000)),
    ...(view.known.has(row.pid) ? { known: view.known.get(row.pid) } : {}),
    ...(view.listening.has(row.pid) ? { listening: true } : {}),
  }));
  const { roles } = classifyPaneProcesses(paneProcesses);
  const byPid = new Map(view.rows.map(row => [row.pid, row]));

  // The top of the command a process belongs to: its outermost ancestor still in the `command` role.
  const commandRoot = (row: ProcessDetailRow): ProcessDetailRow => {
    let root = row;
    for (let parent = byPid.get(root.ppid); parent !== undefined && roles.get(parent.pid) === 'command'; ) {
      root = parent;
      parent = byPid.get(root.ppid);
    }
    return root;
  };
  // A unit's kind is decided once, at its top: a server under a background command is that command's.
  const unitKind = (row: ProcessDetailRow): SessionProcessKind => {
    const root = roles.get(row.pid) === 'command' ? commandRoot(row) : row;
    const path = outputFileOf(root.stdout, root.stderr);
    const taskId = path === undefined ? undefined : claudeTaskId(path);
    return taskId !== undefined && view.backgroundTaskIds.has(taskId) ? 'background' : 'command';
  };

  const listed = new Map<number, ProcessEntry>();
  for (const row of view.rows) {
    const role = roles.get(row.pid);
    const roleKind = role === undefined ? undefined : kindOfRole(role);
    if (roleKind === undefined) continue;
    const kind = roleKind === 'command' ? unitKind(row) : roleKind;
    const parent = listed.get(row.ppid);
    const outputPath = outputFileOf(row.stdout, row.stderr);
    const taskId = outputPath === undefined ? undefined : claudeTaskId(outputPath);
    const label = commandLabel(row.argv);
    const state = stateOf(row.state);
    const toolCommand = role === 'command' && (parent === undefined || roles.get(row.ppid) !== 'command');
    listed.set(row.pid, {
      id: processIdOf(row.pid, row.start),
      row,
      ...(parent === undefined ? {} : { parentId: parent.id }),
      ...(label === undefined ? {} : { label }),
      kind,
      state,
      output: liveOutputAvailability(row.stdout, row.stderr),
      ...(outputPath === undefined ? {} : { outputPath }),
      ...(taskId === undefined ? {} : { taskId }),
      toolCommand,
      // A helper is the harness's own — the tools server, an MCP server — and stopping it breaks the
      // ferret rather than a command; a zombie has already exited and only its parent can reap it.
      stoppable: kind !== 'helper' && state !== 'zombie',
    });
  }
  return depthFirst([...listed.values()]);
}

function depthFirst(entries: readonly ProcessEntry[]): readonly ProcessEntry[] {
  const children = new Map<string | undefined, ProcessEntry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentId) ?? [];
    siblings.push(entry);
    children.set(entry.parentId, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((left, right) => left.row.startedAtMs - right.row.startedAtMs || left.row.pid - right.row.pid);
  const ordered: ProcessEntry[] = [];
  const visit = (parentId: string | undefined): void => {
    for (const entry of children.get(parentId) ?? []) {
      ordered.push(entry);
      visit(entry.id);
    }
  };
  visit(undefined);
  return ordered;
}

/**
 * Every descendant of `pid` in `rows` (which lists parents before children), deepest first, then `pid`
 * itself — the order Stop signals them in, so a parent never respawns a child it just lost.
 */
export function stopOrder(pid: number, rows: readonly ProcessDetailRow[]): readonly ProcessDetailRow[] {
  const members = new Set([pid]);
  const subtree: ProcessDetailRow[] = [];
  const self = rows.find(row => row.pid === pid);
  for (const row of rows)
    if (members.has(row.ppid) && !members.has(row.pid)) {
      members.add(row.pid);
      subtree.push(row);
    }
  return [...subtree.reverse(), ...(self === undefined ? [] : [self])];
}

/**
 * CPU use as a share of one core: across the time since the previous look when there was one, otherwise
 * across the process's whole life.
 */
export function cpuPercent(
  row: ProcessDetailRow,
  previous: { readonly cpuSeconds: number; readonly atMs: number } | undefined,
  nowMs: number,
): number | undefined {
  if (row.cpuSeconds === undefined) return undefined;
  const since = previous !== undefined && previous.cpuSeconds <= row.cpuSeconds ? previous : undefined;
  const elapsedSeconds = (nowMs - (since?.atMs ?? row.startedAtMs)) / 1000;
  if (elapsedSeconds <= 0) return undefined;
  const used = row.cpuSeconds - (since?.cpuSeconds ?? 0);
  return Math.round(Math.max(0, (used / elapsedSeconds) * 100) * 10) / 10;
}
