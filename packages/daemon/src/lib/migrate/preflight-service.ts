import type { SessionStatus } from '@ferretry/protocol';
import { backgroundTerminalCount } from './background-terminals.ts';
import { assembleInflightReport, gateInflight, type GateDecision, type InflightReport } from './inflight-report.ts';
import { handoffMessage, renderMigrationOutcome, type MigrationOutcome } from './outcome-render.ts';
import type { ProcessInventoryPort } from './process-inventory-port.ts';
import { renderInflightCli, renderInflightReport, type ReportMeta } from './report-render.ts';
import { joinOpenTools } from './tool-inventory.ts';

/** The session facts the preflight needs, projected out of whatever served them. */
export interface MigrateTargetView {
  readonly sessionId: string;
  /** The harness family. Only `codex` reports background terminals in its pane footer. */
  readonly harness: string;
  readonly tmuxSession: string;
  readonly status: SessionStatus;
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
 * one is an observation, the other is a blind spot, and collapsing them makes every migration of a
 * stopped codex session refuse on evidence nobody could have produced.
 */
export interface PaneSnapshotPort {
  visible(tmuxSession: string): Promise<string | undefined>;
}

const CODEX_HARNESS = 'codex';

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Joins every signal a destructive migration must weigh — the session's own state, its open tool
 * transcript, the pane's process tree, and the codex footer — into one report, and answers whether
 * migrating is allowed.
 *
 * It degrades rather than throws: a signal it cannot read becomes a named blind spot, which the
 * gate then refuses on. Losing a signal must never look like the absence of work.
 */
export class MigrationPreflight {
  constructor(
    private readonly inventory: ProcessInventoryPort,
    private readonly panes: PaneSnapshotPort,
  ) {}

  /** `chatTail` is the transcript window the session's open tool ids are joined against. */
  async inspect(view: MigrateTargetView, chatTail: readonly unknown[] = []): Promise<InflightReport> {
    const processes = await this.inventory.collect(view.tmuxSession);
    const codex = await this.countBackgroundTerminals(view);
    return assembleInflightReport({
      status: view.status,
      turn: view.turn,
      openTools: joinOpenTools(view.openTools, chatTail),
      processes,
      codexBackgroundTerminals: codex.count,
      subprocessSince: view.subprocessSince,
      blindSpots: codex.blindSpots,
    });
  }

  private async countBackgroundTerminals(
    view: MigrateTargetView,
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

  /** The compact table printed to a terminal on refusal. */
  summarize(report: InflightReport): string {
    return renderInflightCli(report);
  }

  /** The forensic record written before the attempt; see {@link renderInflightReport}. */
  document(report: InflightReport, meta: ReportMeta): string {
    return renderInflightReport(report, meta);
  }

  /** The section appended once the attempt settles; the only part allowed to claim it happened. */
  settle(outcome: MigrationOutcome): string {
    return renderMigrationOutcome(outcome);
  }

  /** The message that points the migrated agent at its report. */
  handoff(reportPath: string): string {
    return handoffMessage(reportPath);
  }
}
