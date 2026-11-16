import { commandLabel } from '@ferretry/std';
import type { SessionStatus } from '../protocol/session-base.ts';
import type { SessionTurnState } from '../protocol/session.ts';
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
import type { ProcessInventoryPort } from './process-inventory-port.ts';
import { type ReportMeta, renderInflightCli, renderInflightReport } from './report-render.ts';
import { requesterCall } from './requester-call.ts';
import { restartNotice } from './restart-notice.ts';
import { joinOpenTools } from './tool-inventory.ts';

/** The session facts the preflight needs, projected out of whatever served them. */
export interface MoveTargetView {
  readonly sessionId: string;
  /** The harness family. Only `codex` reports background terminals in its pane footer. */
  readonly harness: string;
  readonly tmuxSession: string;
  readonly status: SessionStatus;
  /** Whose turn it is (the turn watch's answer); only `working` means a turn is in progress. See {@link InflightReport.midTurn}. */
  readonly turnState?: SessionTurnState;
  readonly turn: number;
  readonly openTools: readonly string[];
  readonly subprocessSince?: string;
}

/**
 * Reads a pane's visible text. Codex prints its background-terminal count in the footer.
 *
 * `undefined` means the pane is CONFIRMED ABSENT — the terminal this session used to have is gone,
 * so there is no footer and no background terminals rather than a footer nobody could read. It is
 * distinct from a throw, which is the honest answer when the pane may exist and the read failed:
 * one is an observation, the other is a blind spot, and collapsing them makes every move of a
 * stopped codex session refuse on evidence nobody could have produced.
 */
export interface PaneSnapshotPort {
  visible(tmuxSession: string): Promise<string | undefined>;
}

const CODEX_HARNESS = 'codex';

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
    private readonly panes: PaneSnapshotPort,
  ) {}

  /** `chatTail` is the transcript window the session's open tool ids are joined against. */
  async inspect(
    view: MoveTargetView,
    chatTail: readonly unknown[] = [],
    options: { readonly requesterPid?: number } = {},
  ): Promise<InflightReport> {
    const collected = await this.inventory.collect(view.tmuxSession);
    // The call that asked for the move is not work the move interrupts; see requesterCall for the proof it needs.
    const chain = collected.kind === 'observed' ? requesterCall(collected.processes, options.requesterPid) : [];
    const own = new Set(chain);
    const call = collected.kind === 'observed' ? collected.processes.filter(entry => own.has(entry.pid)) : [];
    const processes: ProcessObservation =
      collected.kind === 'observed' && call.length > 0
        ? { kind: 'observed', processes: collected.processes.filter(entry => !own.has(entry.pid)) }
        : collected;
    const codex = await this.countBackgroundTerminals(view);
    const openTools = withoutRequesterTool(joinOpenTools(view.openTools, chatTail), call);
    const report = assembleInflightReport({
      status: view.status,
      ...(view.turnState === undefined ? {} : { turnState: view.turnState }),
      turn: view.turn,
      openTools,
      processes,
      codexBackgroundTerminals: codex.count,
      subprocessSince: view.subprocessSince,
      blindSpots: codex.blindSpots,
    });
    return call.length > 0 ? { ...report, requesterCall: call } : report;
  }

  private async countBackgroundTerminals(
    view: MoveTargetView,
  ): Promise<{ readonly count: number; readonly blindSpots: readonly string[] }> {
    if (view.harness !== CODEX_HARNESS) return { count: 0, blindSpots: [] };
    try {
      const visible = await this.panes.visible(view.tmuxSession);
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
