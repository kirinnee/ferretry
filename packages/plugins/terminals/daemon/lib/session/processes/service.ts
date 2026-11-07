import {
  SESSION_PROCESS_COMMAND_MAX,
  SESSION_PROCESS_OUTPUT_READ_MAX,
  type SessionProcess,
  type SessionProcessExit,
  type SessionProcessList,
  type SessionProcessOutput,
  type SessionProcessOutputAvailability,
  type SessionProcessStopResult,
} from '@ferretry/protocol';
import { truncateCommand } from './commands.ts';
import type { EndedProcess, ProcessHistory } from './history.ts';
import { cpuPercent, type ProcessEntry, parseProcessId, processEntries, stopOrder } from './model.ts';
import { deliverableLength, leadingContinuationBytes, readWindow } from './output.ts';
import type {
  OutputFilePort,
  ProcessClock,
  ProcessDetailRow,
  ProcessProvenancePort,
  ProcessSignalPort,
  ProcessTextRedactor,
  ProcessTreePort,
  SessionPaneProofPort,
  SessionTranscriptTailPort,
} from './ports.ts';
import {
  NO_TRANSCRIPT_EVIDENCE,
  resultFor,
  type TranscriptEvidence,
  transcriptEvidence,
} from './transcript-evidence.ts';

/** How many recent conversation events are searched for what the harness recorded about its commands. */
const PROCESS_TRANSCRIPT_TAIL = 400;

export type SessionProcessFailure = 'not_found' | 'changed' | 'not_stoppable';

export class SessionProcessError extends Error {
  constructor(
    readonly failure: SessionProcessFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionProcessError';
  }
}

export interface SessionProcessDependencies {
  readonly panes: SessionPaneProofPort;
  readonly tree: ProcessTreePort;
  readonly provenance: ProcessProvenancePort;
  readonly files: OutputFilePort;
  readonly signals: ProcessSignalPort;
  readonly transcript: SessionTranscriptTailPort;
  readonly redactor: ProcessTextRedactor;
  readonly history: ProcessHistory;
  readonly clock: ProcessClock;
  /**
   * Folders whose files are never served as output, whatever a process's descriptor points at — the
   * daemon's own state home first. A process can be started with its output appended to any file its
   * user can open; this keeps that from becoming a way to read Ferretry's credentials through this route.
   */
  readonly refusedOutputRoots: readonly string[];
}

interface Look {
  readonly rootPid: number;
  readonly rows: readonly ProcessDetailRow[];
  readonly entries: readonly ProcessEntry[];
  readonly evidence: TranscriptEvidence;
  readonly nowMs: number;
}

/**
 * A FERRET'S PROCESSES: list them, follow one's output, stop one.
 *
 * ONLY THIS FERRET'S PANE IS WALKED. The root is the pane the attach proof names — the session's single
 * registration, matched on pane id, pid and process start — never a session name, so a reused name or
 * pid can never point the walk at another ferret's processes or the machine's.
 *
 * NOTHING IS READ THAT ANOTHER READER OWNS. Output comes only from a regular file a process's stdout or
 * stderr already points at, or from the transcript; a terminal, a pipe or a socket is reported as
 * unreadable with the reason, because opening one would take the bytes away from whoever reads it.
 *
 * EVERY STRING IS SCRUBBED. Command lines and output pass through the vault redactor, which fails
 * closed: text it cannot scrub is not served.
 */
export class SessionProcessService {
  constructor(private readonly deps: SessionProcessDependencies) {}

  async list(sessionId: string): Promise<SessionProcessList> {
    const look = await this.look(sessionId);
    const observedAt = new Date(look.kind === 'looked' ? look.look.nowMs : this.deps.clock.nowMs()).toISOString();
    if (look.kind === 'unavailable') {
      const ended = await this.endedProcesses(look.ended, look.evidence);
      return await this.redactList({
        sessionId,
        observedAt,
        available: false,
        reason: look.reason,
        processes: [...ended],
      });
    }
    const { entries, nowMs } = look.look;
    // CPU rates read the previous look's samples, so they are taken before this look is recorded.
    const live = entries.map(entry => this.liveProcess(sessionId, entry, nowMs));
    const ended = await this.endedProcesses(this.deps.history.observe(sessionId, entries, nowMs), look.look.evidence);
    return await this.redactList({ sessionId, observedAt, available: true, processes: [...live, ...ended] });
  }

  async output(sessionId: string, processId: string, after: number | undefined): Promise<SessionProcessOutput> {
    const id = this.parse(processId);
    let ended = this.deps.history.ended(sessionId, processId);
    let entry: ProcessEntry | undefined;
    if (ended === undefined) {
      const look = await this.look(sessionId);
      if (look.kind === 'looked') {
        entry = look.look.entries.find(candidate => candidate.row.pid === id.pid && candidate.row.start === id.start);
        // Gone since the list was drawn: the look that noticed records it as ended.
        if (entry === undefined) {
          this.deps.history.observe(sessionId, look.look.entries, look.look.nowMs);
          ended = this.deps.history.ended(sessionId, processId);
        }
      } else ended = look.ended.find(item => item.entry.id === processId);
    }
    if (entry !== undefined) return await this.readOutput(processId, entry, after, false);
    if (ended === undefined)
      throw new SessionProcessError('not_found', `process ${processId} is not one of this ferret's processes`);
    const evidence = await this.evidence(sessionId);
    const result = resultFor(evidence, ended.entry.label, ended.entry.row.startedAtMs);
    if (ended.entry.outputPath !== undefined) {
      const read = await this.readOutput(processId, ended.entry, after, true);
      if (read.source === 'file' || result === undefined) return read;
    }
    if (result !== undefined) {
      // A recorded result never changes, so it is scrubbed WHOLE and its offsets count the scrubbed text:
      // a follower's `after` then slices text no secret can straddle.
      const bytes = new TextEncoder().encode(await this.deps.redactor.batch(scrub => scrub.text(result.text)));
      const window = readWindow(bytes.byteLength, after, SESSION_PROCESS_OUTPUT_READ_MAX);
      const lead = leadingContinuationBytes(bytes.subarray(window.from, window.to), window.skipped);
      return {
        processId,
        source: 'transcript',
        text: new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(window.from + lead, window.to)),
        start: window.from + lead,
        end: window.to,
        size: bytes.byteLength,
        skipped: window.skipped,
        reset: window.reset,
        complete: true,
      };
    }
    return none(processId, 'It ended before its output could be kept.', true);
  }

  async stop(sessionId: string, processId: string): Promise<SessionProcessStopResult> {
    const id = this.parse(processId);
    const look = await this.look(sessionId);
    if (look.kind === 'unavailable')
      throw new SessionProcessError('changed', `process ${processId} has already ended: ${look.reason}`);
    const entry = look.look.entries.find(candidate => candidate.row.pid === id.pid && candidate.row.start === id.start);
    if (entry === undefined)
      throw new SessionProcessError(
        'changed',
        `process ${processId} is no longer running under this ferret, or its pid now belongs to another process`,
      );
    if (!entry.stoppable)
      throw new SessionProcessError(
        'not_stoppable',
        entry.kind === 'helper'
          ? 'that process belongs to the agent itself (a helper it needs), so it is not stopped from here'
          : 'that process has already exited',
      );
    let signalled = 0;
    for (const row of stopOrder(entry.row.pid, look.look.rows)) {
      // PROVED AGAIN, IMMEDIATELY BEFORE THE SIGNAL. The pid was this ferret's at the look; a process that
      // exited since and whose pid the kernel handed on has a different start, and is left alone.
      if ((await this.deps.tree.startOf(row.pid)) !== row.start) continue;
      if (await this.deps.signals.terminate(row.pid)) signalled += 1;
    }
    return { processId, signalled };
  }

  private parse(processId: string): { readonly pid: number; readonly start: number } {
    const id = parseProcessId(processId);
    if (id === undefined)
      throw new SessionProcessError('not_found', `${JSON.stringify(processId)} is not a process id`);
    return id;
  }

  private async look(sessionId: string): Promise<
    | { readonly kind: 'looked'; readonly look: Look }
    | {
        readonly kind: 'unavailable';
        readonly reason: string;
        readonly ended: readonly EndedProcess[];
        readonly evidence: TranscriptEvidence;
      }
  > {
    const unavailable = async (reason: string) => {
      const ended = this.deps.history.endAll(sessionId, this.deps.clock.nowMs());
      return {
        kind: 'unavailable' as const,
        reason,
        ended,
        evidence: ended.length === 0 ? NO_TRANSCRIPT_EVIDENCE : await this.evidence(sessionId),
      };
    };
    let rootPid: number;
    try {
      rootPid = (await this.deps.panes.resolve(sessionId)).pid;
    } catch {
      // The attach proof's own refusal names tmux internals; a person needs only the consequence.
      return await unavailable("This ferret isn't running, so it has no processes right now.");
    }
    const tree = await this.deps.tree.tree(rootPid);
    if (tree.kind === 'unavailable') return await unavailable(tree.reason);
    const [known, evidence] = await Promise.all([
      this.deps.provenance.identify(tree.rows, rootPid),
      this.evidence(sessionId),
    ]);
    const unexplained = tree.rows.filter(row => !known.has(row.pid)).map(row => row.pid);
    const listening = (await this.deps.tree.listening(unexplained).catch(() => undefined)) ?? new Set<number>();
    const nowMs = this.deps.clock.nowMs();
    const entries = processEntries({
      rows: tree.rows,
      known,
      listening,
      backgroundTaskIds: evidence.backgroundTaskIds,
      nowMs,
    }).map(entry => this.refuseStateHome(entry));
    return {
      kind: 'looked',
      look: { rootPid, rows: tree.rows, entries, evidence, nowMs },
    };
  }

  private refuseStateHome(entry: ProcessEntry): ProcessEntry {
    const path = entry.outputPath;
    if (path === undefined) return entry;
    const refused = this.deps.refusedOutputRoots.some(root => path === root || path.startsWith(`${root}/`));
    if (!refused) return entry;
    const { outputPath: _dropped, ...rest } = entry;
    return {
      ...rest,
      output: { source: 'none', reason: "Its output goes into Ferretry's own state folder, which is never shown." },
    };
  }

  private async evidence(sessionId: string): Promise<TranscriptEvidence> {
    const tail = await this.deps.transcript.tail(sessionId, PROCESS_TRANSCRIPT_TAIL).catch(() => undefined);
    return tail?.kind === 'read' ? transcriptEvidence(tail.events) : NO_TRANSCRIPT_EVIDENCE;
  }

  private liveProcess(sessionId: string, entry: ProcessEntry, nowMs: number): SessionProcess {
    const cpu = cpuPercent(entry.row, this.deps.history.sample(sessionId, entry.id), nowMs);
    return {
      ...wireBase(entry),
      state: entry.state,
      ...(cpu === undefined ? {} : { cpuPercent: cpu }),
      ...(entry.row.rssBytes === undefined ? {} : { rssBytes: entry.row.rssBytes }),
      output: entry.output,
      stoppable: entry.stoppable,
    };
  }

  private async endedProcesses(
    ended: readonly EndedProcess[],
    evidence: TranscriptEvidence,
  ): Promise<readonly SessionProcess[]> {
    const processes: SessionProcess[] = [];
    for (const item of ended) {
      const { entry } = item;
      const result = resultFor(evidence, entry.label, entry.row.startedAtMs);
      const exit: SessionProcessExit | undefined =
        (entry.taskId === undefined ? undefined : evidence.taskExits.get(entry.taskId)) ?? result?.exit;
      // An ended command's own children went with it: it is listed on its own.
      const { parentId: _gone, ...base } = wireBase(entry);
      processes.push({
        ...base,
        state: 'exited',
        endedAt: new Date(item.endedAtMs).toISOString(),
        ...(exit === undefined ? {} : { exit }),
        output: await this.endedAvailability(entry, result !== undefined),
        stoppable: false,
      });
    }
    return processes;
  }

  private async endedAvailability(entry: ProcessEntry, recorded: boolean): Promise<SessionProcessOutputAvailability> {
    if (entry.outputPath !== undefined) {
      const probe = await this.deps.files.read(entry.outputPath, 0, 0).catch(() => undefined);
      if (probe?.kind === 'read') return { source: 'file' };
    }
    if (recorded) return { source: 'transcript' };
    if (entry.output.source === 'none') return entry.output;
    return { source: 'none', reason: 'It ended before its output could be kept.' };
  }

  private async readOutput(
    processId: string,
    entry: ProcessEntry,
    after: number | undefined,
    complete: boolean,
  ): Promise<SessionProcessOutput> {
    if (entry.outputPath === undefined)
      return none(processId, entry.output.reason ?? 'Nothing it writes can be read here.', complete);
    const read = await this.deps.files.read(entry.outputPath, after, SESSION_PROCESS_OUTPUT_READ_MAX);
    if (read.kind === 'gone')
      return none(
        processId,
        complete ? 'It ended before its output could be kept.' : 'Its output file is gone.',
        complete,
      );
    if (read.kind === 'refused') return none(processId, read.reason, complete);
    // The same window the reader cut, so a reset with a long file is also reported as skipping its head.
    const { skipped, reset } = readWindow(read.size, after, SESSION_PROCESS_OUTPUT_READ_MAX);
    const lead = leadingContinuationBytes(read.bytes, skipped);
    const body = read.bytes.subarray(lead);
    const length = deliverableLength(body, complete);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, length));
    const start = read.start + lead;
    return await this.redactOutput({
      processId,
      source: 'file',
      text,
      start: length === 0 ? (after !== undefined && !reset && !skipped ? after : start) : start,
      end: start + length,
      size: read.size,
      skipped,
      reset,
      complete,
    });
  }

  private async redactOutput(output: SessionProcessOutput): Promise<SessionProcessOutput> {
    return await this.deps.redactor.batch(scrub => ({ ...output, text: scrub.text(output.text) }));
  }

  private async redactList(list: SessionProcessList): Promise<SessionProcessList> {
    return await this.deps.redactor.batch(scrub => ({
      ...list,
      processes: list.processes.map(item => {
        const command = truncateCommand(scrub.text(item.command), SESSION_PROCESS_COMMAND_MAX);
        const label =
          item.label === undefined
            ? undefined
            : truncateCommand(scrub.text(item.label), SESSION_PROCESS_COMMAND_MAX).text;
        return {
          ...item,
          command: command.text,
          commandTruncated: item.commandTruncated || command.truncated,
          ...(label === undefined ? {} : { label }),
        };
      }),
    }));
  }
}

function wireBase(entry: ProcessEntry): Omit<SessionProcess, 'state' | 'output' | 'stoppable'> {
  // Cut to the wire limit only AFTER scrubbing (`redactList`): a secret straddling the limit would leak its prefix.
  return {
    id: entry.id,
    pid: entry.row.pid,
    ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    command: entry.row.argv || `pid ${entry.row.pid}`,
    commandTruncated: false,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    kind: entry.kind,
    startedAt: new Date(entry.row.startedAtMs).toISOString(),
  };
}

function none(processId: string, reason: string, complete: boolean): SessionProcessOutput {
  return {
    processId,
    source: 'none',
    reason,
    text: '',
    start: 0,
    end: 0,
    size: 0,
    skipped: false,
    reset: false,
    complete,
  };
}
