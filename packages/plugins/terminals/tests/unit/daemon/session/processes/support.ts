import type { SessionAttachTarget } from '@ferretry/protocol';
import { ProcessHistory } from '../../../../src/lib/session/processes/history.ts';
import { readWindow } from '../../../../src/lib/session/processes/output.ts';
import type {
  OutputFilePort,
  OutputFileRead,
  ProcessDetailRow,
  ProcessProvenancePort,
  ProcessSignalPort,
  ProcessStreamTarget,
  ProcessTextRedactor,
  ProcessTreePort,
  ProcessTreeRead,
  SessionPaneProofPort,
  SessionTranscriptTailPort,
} from '../../../../src/lib/session/processes/ports.ts';
import { SessionProcessService } from '../../../../src/lib/session/processes/service.ts';
import type { TranscriptTailResult } from '../../../../src/lib/session/reads/service.ts';
import type { TranscriptEvent, TranscriptJsonValue } from '../../../../src/lib/transcript/types.ts';

/**
 * THE PROCESSES SERVICE'S PORTS, IN MEMORY. Every fake records what it was asked, so "nothing was
 * signalled" and "the file was never opened" are facts the tests read rather than infer.
 */

export const NOW = Date.parse('2026-10-29T10:00:00.000Z');
export const PANE_PID = 500;
export const HARNESS_PID = 501;
export const MCP_PID = 502;
export const SESSION = 's1';

export interface RowSpec {
  readonly pid: number;
  readonly ppid: number;
  readonly argv: string;
  readonly ageSeconds?: number;
  readonly state?: string;
  readonly cpuSeconds?: number;
  readonly rssBytes?: number;
  readonly stdout?: ProcessStreamTarget;
  readonly stderr?: ProcessStreamTarget;
}

export const rowOf = (spec: RowSpec): ProcessDetailRow => ({
  pid: spec.pid,
  ppid: spec.ppid,
  start: spec.pid * 1_000,
  startedAtMs: NOW - (spec.ageSeconds ?? 60) * 1000,
  argv: spec.argv,
  state: spec.state ?? 'S',
  ...(spec.cpuSeconds === undefined ? {} : { cpuSeconds: spec.cpuSeconds }),
  ...(spec.rssBytes === undefined ? {} : { rssBytes: spec.rssBytes }),
  ...(spec.stdout === undefined ? {} : { stdout: spec.stdout }),
  ...(spec.stderr === undefined ? {} : { stderr: spec.stderr }),
});

export const HARNESS_ROW = rowOf({ pid: HARNESS_PID, ppid: PANE_PID, argv: 'claude', ageSeconds: 3_600 });
export const MCP_ROW = rowOf({ pid: MCP_PID, ppid: HARNESS_PID, argv: '/usr/bin/fy mcp serve', ageSeconds: 3_599 });

export const claudeWrapper = (command: string): string =>
  `/usr/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| /tmp/claude-d9b0-cwd`;

const TASKS = '/tmp/claude-1000/proj/session/tasks';
export const taskPath = (id: string): string => `${TASKS}/${id}.output`;
export const taskFile = (id: string): ProcessStreamTarget => ({ kind: 'file', path: taskPath(id) });

/** The id the wire carries for a row. */
export const idOf = (row: ProcessDetailRow): string => `${row.pid}.${row.start}`;

class FakePanes implements SessionPaneProofPort {
  refusal: Error | undefined;
  readonly asked: string[] = [];

  async resolve(sessionId: string): Promise<SessionAttachTarget> {
    this.asked.push(sessionId);
    if (this.refusal !== undefined) throw this.refusal;
    return {
      socketPath: '/tmp/tmux.sock',
      tmuxSession: `fy-${sessionId}`,
      paneId: '%7',
      pid: PANE_PID,
      processStartTicks: 918_273,
    };
  }
}

class FakeTree implements ProcessTreePort {
  rows: readonly ProcessDetailRow[] = [HARNESS_ROW, MCP_ROW];
  unavailable: string | undefined;
  readonly listeningPids = new Set<number>();
  listeningFails = false;
  /** Starts `startOf` answers instead of the row's own: a pid reused since the look. */
  readonly startOverrides = new Map<number, number | undefined>();
  readonly walked: number[] = [];
  readonly listeningAsked: (readonly number[])[] = [];
  readonly startAsked: number[] = [];

  async tree(rootPid: number): Promise<ProcessTreeRead> {
    this.walked.push(rootPid);
    return this.unavailable === undefined
      ? { kind: 'read', rows: this.rows }
      : { kind: 'unavailable', reason: this.unavailable };
  }

  async listening(pids: readonly number[]): Promise<ReadonlySet<number> | undefined> {
    this.listeningAsked.push(pids);
    if (this.listeningFails) throw new Error('lsof is missing');
    return new Set(pids.filter(pid => this.listeningPids.has(pid)));
  }

  async startOf(pid: number): Promise<number | undefined> {
    this.startAsked.push(pid);
    if (this.startOverrides.has(pid)) return this.startOverrides.get(pid);
    return this.rows.find(row => row.pid === pid)?.start;
  }
}

class FakeProvenance implements ProcessProvenancePort {
  readonly asked: { readonly pids: readonly number[]; readonly rootPid: number }[] = [];

  async identify(rows: readonly ProcessDetailRow[], rootPid: number) {
    this.asked.push({ pids: rows.map(row => row.pid), rootPid });
    const known = new Map<number, { readonly kind: string }>();
    for (const row of rows) {
      if (row.pid === HARNESS_PID) known.set(row.pid, { kind: 'harness' });
      if (row.pid === MCP_PID) known.set(row.pid, { kind: 'ferretry-tools' });
    }
    return known;
  }
}

/** A regular-file store with the adapter's own windowing, plus the two refusals the adapter has. */
class FakeFiles implements OutputFilePort {
  readonly contents = new Map<string, Uint8Array>();
  readonly refused = new Map<string, string>();
  readonly reads: { readonly path: string; readonly from: number | undefined; readonly max: number }[] = [];

  put(path: string, text: string | Uint8Array): void {
    this.contents.set(path, typeof text === 'string' ? new TextEncoder().encode(text) : text);
  }

  append(path: string, text: string): void {
    const held = this.contents.get(path) ?? new Uint8Array();
    const added = new TextEncoder().encode(text);
    const next = new Uint8Array(held.byteLength + added.byteLength);
    next.set(held);
    next.set(added, held.byteLength);
    this.contents.set(path, next);
  }

  async read(path: string, from: number | undefined, max: number): Promise<OutputFileRead> {
    this.reads.push({ path, from, max });
    const reason = this.refused.get(path);
    if (reason !== undefined) return { kind: 'refused', reason };
    const held = this.contents.get(path);
    if (held === undefined) return { kind: 'gone' };
    const window = readWindow(held.byteLength, from, max);
    return { kind: 'read', bytes: held.slice(window.from, window.to), start: window.from, size: held.byteLength };
  }
}

class FakeSignals implements ProcessSignalPort {
  readonly sent: number[] = [];
  /** Pids that have already exited by the time they are signalled. */
  readonly gone = new Set<number>();

  async terminate(pid: number): Promise<boolean> {
    this.sent.push(pid);
    return !this.gone.has(pid);
  }
}

class FakeTranscript implements SessionTranscriptTailPort {
  events: readonly TranscriptEvent[] = [];
  failure: Error | undefined;
  unresolved = false;
  readonly asked: { readonly sessionId: string; readonly limit: number }[] = [];

  async tail(sessionId: string, limit: number): Promise<TranscriptTailResult> {
    this.asked.push({ sessionId, limit });
    if (this.failure !== undefined) throw this.failure;
    if (this.unresolved) return { kind: 'unresolved' };
    return { kind: 'read', events: this.events };
  }
}

/** Masks one stored secret value, as the vault's redactor does, and can be made to fail closed. */
class FakeRedactor implements ProcessTextRedactor {
  failure: Error | undefined;
  batches = 0;

  constructor(private readonly secrets: ReadonlyMap<string, string> = new Map()) {}

  async batch<T>(work: (scrub: { text(text: string): string }) => T): Promise<T> {
    this.batches += 1;
    if (this.failure !== undefined) throw this.failure;
    return work({
      text: text => {
        let scrubbed = text;
        for (const [name, value] of this.secrets) scrubbed = scrubbed.replaceAll(value, `‹secret:${name}›`);
        return scrubbed;
      },
    });
  }
}

export const toolCall = (id: string, input: TranscriptJsonValue, name = 'Bash'): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: { id, name, input },
});

export const toolResult = (
  callId: string,
  text: string,
  options: { readonly isError?: boolean; readonly timestamp?: string } = {},
): TranscriptEvent => ({
  kind: 'tool-result',
  harness: 'claude',
  role: 'tool',
  ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  result: { callId, content: text, text, isError: options.isError ?? false },
});

export const harnessMessage = (text: string): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role: 'user',
  text,
});

export const taskNotification = (taskId: string, status: string, summary: string): string =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

export interface ProcessWorldOptions {
  readonly secrets?: ReadonlyMap<string, string>;
  readonly refusedOutputRoots?: readonly string[];
}

/** The service over every fake, with the real history and a clock the test moves. */
export function processWorld(options: ProcessWorldOptions = {}) {
  const panes = new FakePanes();
  const tree = new FakeTree();
  const provenance = new FakeProvenance();
  const files = new FakeFiles();
  const signals = new FakeSignals();
  const transcript = new FakeTranscript();
  const redactor = new FakeRedactor(options.secrets);
  const history = new ProcessHistory();
  const clock = { now: NOW };
  const service = new SessionProcessService({
    panes,
    tree,
    provenance,
    files,
    signals,
    transcript,
    redactor,
    history,
    clock: { nowMs: () => clock.now },
    refusedOutputRoots: options.refusedOutputRoots ?? ['/home/kirin/.ferretry'],
  });
  return { service, panes, tree, provenance, files, signals, transcript, redactor, history, clock };
}

export type ProcessWorld = ReturnType<typeof processWorld>;
