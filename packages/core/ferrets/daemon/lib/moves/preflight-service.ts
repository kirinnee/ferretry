import { commandLabel } from '@ferretry/std';
import type { SessionStatus } from '../protocol/session-base.ts';
import type { SessionTurnState } from '../protocol/session.ts';
import type { HarnessFacts } from '../../../contract/index.ts';
import type { MoveRefusal } from '../../../contract/move.ts';
import { type AgentJob, blockingAgentJobs } from './agent-jobs.ts';
import { backgroundTerminalCount } from './background-terminals.ts';
import { describeInflight } from './inflight-describe.ts';
import {
  assembleInflightReport,
  type GateDecision,
  gateInflight,
  type InflightReport,
  type OpenToolInfo,
  type ProcessInfo,
  type ProcessObservation,
} from './inflight-report.ts';
import { type MoveOutcome, renderMoveOutcome } from './outcome-render.ts';
import type { MovePane, ProcessInventoryPort } from './process-inventory-port.ts';
import { type ReportMeta, renderInflightCli, renderInflightReport } from './report-render.ts';
import { requesterCall } from './requester-call.ts';
import { restartNotice } from './restart-notice.ts';
import { COMMAND_NOT_FOUND, joinOpenTools } from './tool-inventory.ts';

/** The session facts the preflight needs, projected out of whatever served them. */
export interface MoveTargetView {
  readonly sessionId: string;
  /** The harness the session records (a family or a key); its facts say whether its pane footer reports background terminals. */
  readonly harness: string;
  /** The ferret's pane, reached through its runner: the process tree and the codex footer are read from it. */
  readonly pane: MovePane;
  readonly status: SessionStatus;
  /** Whose turn it is (the turn watch's answer); only `working` means a turn is in progress. See {@link InflightReport.midTurn}. */
  readonly turnState?: SessionTurnState;
  /** The session is stopped on a tool-permission prompt; see `AssembleInflightReportInput.awaitingPermission`. */
  readonly awaitingPermission?: boolean;
  readonly turn: number;
  /**
   * The tool calls the session has open, or `undefined` when its state does not RECORD them (today nothing writes them): an
   * unrecorded list is UNKNOWN, never "none", so it cannot be used to claim that a shell is a background job.
   */
  readonly openTools: readonly string[] | undefined;
  readonly subprocessSince?: string;
}

/**
 * The open tool call that IS the requesting call: the harness records the command the agent wrote, and the proven tool
 * shell's argv carries that same command inside its wrapper, so the ONE Bash call whose text equals it is the call
 * that asked. No call = no match = nothing is left out, and the move refuses as before.
 */
function withoutRequesterTool(tools: readonly OpenToolInfo[], call: readonly ProcessInfo[]): readonly OpenToolInfo[] {
  const shell = call.find(entry => entry.toolShell === entry.pid);
  const command = shell === undefined ? undefined : commandLabel(shell.argv);
  if (command === undefined) return tools;
  const index = tools.findIndex(tool => tool.name === 'Bash' && tool.summary === command);
  return index === -1 ? tools : tools.filter((_, position) => position !== index);
}

/**
 * Whether every open tool call is identified: its name is known and, for a Bash call, so is the command. Only then can
 * "no open call matches this shell" be believed. On a base whose transcript tail is empty NO call is ever identified.
 */
const everyOpenToolIdentified = (tools: readonly OpenToolInfo[]): boolean =>
  tools.every(
    tool =>
      tool.name !== '?' && tool.summary !== COMMAND_NOT_FOUND && !(tool.name === 'Bash' && tool.summary === tool.name),
  );

/**
 * Words the Claude tool shells whose stdout is `…/tasks/<id>.output`. CLAUDE WRITES EVERY BASH CALL'S STDOUT THERE, so such a
 * shell is a `run_in_background` job only when it outlived its call, and that is claimed ONLY when every open tool is
 * identified and none matches the shell's command (calls NOT recorded at all are unknown, never "none": then only a session at
 * its prompt, with no turn running, is believed). A shell an open call matches is that call, still running (unchanged).
 * Anything else — including every shell when the open calls cannot be identified — is neutrally "a command the agent is
 * running" and stays out of the hand-over's list of stopped background jobs. Only wording changes; the verdict is untouched.
 */
export function withUnkeptJobs(
  processes: ProcessObservation,
  /** `undefined` = the session does not record its open tool calls (unknown, not none). */
  openTools: readonly OpenToolInfo[] | undefined,
  /** The session is at its prompt with no turn in progress: no foreground call can be running, so a call-less shell outlived its call. */
  atPrompt = false,
): ProcessObservation {
  if (processes.kind !== 'observed') return processes;
  const open = new Set((openTools ?? []).filter(tool => tool.name === 'Bash').map(tool => tool.summary));
  // BACKGROUND IS CLAIMED ONLY ON POSITIVE EVIDENCE: the calls are recorded and every one is identified, or no turn is running.
  const certain = openTools === undefined ? atPrompt : everyOpenToolIdentified(openTools);
  return {
    kind: 'observed',
    processes: processes.processes.map(entry => {
      if (entry.claudeTaskId === undefined || entry.toolShell !== entry.pid || entry.known !== undefined) return entry;
      const command = commandLabel(entry.argv);
      if (command !== undefined && open.has(command)) return entry;
      return certain ? { ...entry, unkeptJob: true as const } : { ...entry, agentCommand: true as const };
    }),
  };
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Joins every signal a destructive move must weigh — the session's own state, its open tool
 * transcript, the pane's process tree, and the codex footer — into one report, and answers whether
 * moving is allowed.
 *
 * It degrades rather than throws: a signal it cannot read becomes a named blind spot, which the
 * gate then refuses on. Losing a signal must never look like the absence of work.
 */
export class MovePreflight {
  constructor(
    private readonly inventory: ProcessInventoryPort,
    /** The facts of the harness a session records, or `undefined` for one no harness answers for: it reports no terminals. */
    private readonly factsOf: (harness: string) => HarnessFacts | undefined,
  ) {}

  /** `chatTail` is the transcript window the session's open tool ids are joined against. */
  async inspect(
    view: MoveTargetView,
    chatTail: readonly unknown[] = [],
    options: { readonly requesterPid?: number } = {},
  ): Promise<InflightReport> {
    const collected = await this.inventory.collect(view.pane, view.sessionId);
    // The call that asked for the move is not work the move interrupts; see requesterCall for the proof it needs.
    const chain = collected.kind === 'observed' ? requesterCall(collected.processes, options.requesterPid) : [];
    const own = new Set(chain);
    const call = collected.kind === 'observed' ? collected.processes.filter(entry => own.has(entry.pid)) : [];
    const processes: ProcessObservation =
      collected.kind === 'observed' && call.length > 0
        ? { kind: 'observed', processes: collected.processes.filter(entry => !own.has(entry.pid)) }
        : collected;
    const codex = await this.countBackgroundTerminals(view);
    const openTools = withoutRequesterTool(joinOpenTools(view.openTools ?? [], chatTail), call);
    const atPrompt = view.turnState === 'your-turn' && view.awaitingPermission !== true;
    const processesMarked = withUnkeptJobs(processes, view.openTools === undefined ? undefined : openTools, atPrompt);
    const report = assembleInflightReport({
      status: view.status,
      ...(view.turnState === undefined ? {} : { turnState: view.turnState }),
      ...(view.awaitingPermission === true ? { awaitingPermission: true } : {}),
      turn: view.turn,
      openTools,
      processes: processesMarked,
      codexBackgroundTerminals: codex.count,
      subprocessSince: view.subprocessSince,
      blindSpots: codex.blindSpots,
    });
    return call.length > 0 ? { ...report, requesterCall: call } : report;
  }

  private async countBackgroundTerminals(
    view: MoveTargetView,
  ): Promise<{ readonly count: number; readonly blindSpots: readonly string[] }> {
    if (this.factsOf(view.harness)?.paneReportsBackgroundTerminals !== true) return { count: 0, blindSpots: [] };
    try {
      const visible = await view.pane.screen();
      // A pane that is gone ran nothing: reporting zero here is an observation, not an assumption.
      return { count: visible === undefined ? 0 : backgroundTerminalCount(visible), blindSpots: [] };
    } catch (error) {
      return { count: 0, blindSpots: [`the codex pane footer could not be read: ${detail(error)}`] };
    }
  }

  /** Refuses unless the report is demonstrably safe, or the caller forced the decision. */
  gate(report: InflightReport, options: { readonly force?: boolean } = {}): GateDecision {
    return gateInflight(report, options);
  }

  /** The inventory as data a person can read, carried on the refusal so the PWA can show it. */
  describe(report: InflightReport): MoveRefusal {
    return describeInflight(report);
  }

  /** The agent's own background jobs this report blocks on, which the agent can be asked to stop. */
  agentJobs(report: InflightReport): readonly AgentJob[] {
    return blockingAgentJobs(report);
  }

  /** The compact table printed to a terminal on refusal. */
  summarize(report: InflightReport): string {
    return renderInflightCli(report);
  }

  /** The forensic record written before the attempt; see {@link renderInflightReport}. */
  document(report: InflightReport, meta: ReportMeta): string {
    return renderInflightReport(report, meta);
  }

  /** The section appended once the attempt settles; the only part allowed to claim it happened. */
  settle(outcome: MoveOutcome): string {
    return renderMoveOutcome(outcome);
  }

  /** What the restarted agent is told, or nothing: see {@link restartNotice}. */
  handoff(report: InflightReport, reportPath: string, mode: 'auto' | 'interactive'): string | undefined {
    return restartNotice(report, reportPath, mode);
  }
}
