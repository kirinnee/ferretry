import type { FerretId } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type { TurnUsage } from '../kinds.ts';
import type { AgentControl, LimitsFile } from '../state.ts';

/** What one auto-resume pass did: how many ferrets came back, and which could not, each with the reason a person can act on. */
export interface AutoResumeReport {
  /** When the pass ran (an ISO instant). */
  readonly at: string;
  readonly resumed: number;
  readonly skipped: readonly { readonly sessionId: string; readonly reason: string }[];
}

/**
 * What a ferret's own documents say about it that the insights index needs and its transcript cannot give (today's
 * `createAnalyticsCandidateSource`): the model the operator SELECTED (never the one the harness observed, which is
 * transcript evidence), the daemon's send counter, and the readings its state recorded. Every member is `null` when the
 * document does not say; a null is "not stated", never zero. Read from `config.json` and `state.json`, so a ferret
 * converted from v4 carries it exactly as it was.
 */
export interface FerretIngestEvidence {
  readonly selectedModel: string | null;
  readonly turns: number | null;
  readonly startedAt: string | null;
  readonly contextWindow: number | null;
  readonly contextEndPercent: number | null;
}

/**
 * A limit a LIVE ferret's pane proves its login has reached (today's `storagePaneLimits` row): the harness announced a
 * usage or spend limit that the provider's own reading cannot see. One row per limited live ferret, derived from its
 * state each time it is read and kept nowhere, so it ends the moment the ferret is released (the pane shows no limit
 * any more, or it is stopped) or its reset time passes.
 *
 * `notice` is the harness's own sentence, read from a masked screen. `login` is the login the ferret launched on;
 * `runtime` is the runtime it was started on, for a ferret whose record names no login.
 */
export interface FerretPaneLimit {
  readonly ferret: FerretId;
  readonly runtime?: string;
  readonly login?: string;
  readonly notice: string;
  /** Whether it is a spend limit (money), as opposed to a usage window. */
  readonly spend: boolean;
  /** When the login is usable again, epoch milliseconds; absent when the harness gave no time. */
  readonly retryAt?: number;
}

/** What a ferret spent, limits and displayed facts other plugins read: limits, agent control, usage, ingest evidence, pane limits. */
export interface InsightsApi {
  /** The effective `limits.yaml` settings, read fresh on every call; Ferrets serves it (a consumer may still bind it optionally). */
  effectiveLimits?(): Promise<LimitsFile>;
  /**
   * What this ferret may control right now (today's "What agents may control"): `limits.yaml`'s `agentControl` over
   * today's defaults, read fresh on every call so a change applies to the ferret's very next action. A ferret this
   * daemon does not know may control nothing.
   */
  agentControl(ferret: FerretId): Promise<AgentControl>;
  /**
   * What the last "Auto-resume after restart" pass did (today's `machine.lastAutoResume`), for the Machine view's
   * "Last restart" lines: `null` when none has run or it could not be read. Optional, so it is additive: a Ferrets
   * that keeps none reads as no pass.
   */
  lastAutoResume?(): Promise<AutoResumeReport | null>;
  /**
   * The model a ferret is actually running, for display (today's `displayModel`): what the harness last reported, else the
   * model it was configured with, else the wrapper's declared hint, else `default`. A launch option (`FerretSummary.model`)
   * is only what was ASKED for: it goes stale after a switch inside the session. `undefined` for a ferret this daemon does
   * not know. Optional, so it is additive: absent reads as the launch option.
   */
  displayModel?(ferret: FerretId): Promise<string | undefined>;
  /**
   * What the ferret's own documents say that the insights index needs (see {@link FerretIngestEvidence}): the selected
   * model and the send counter. `undefined` for a ferret this daemon does not know or whose documents do not parse.
   * Optional, so it is additive: absent reads as no evidence beyond the summary.
   */
  ingestEvidence?(ferret: FerretId): Promise<FerretIngestEvidence | undefined>;
  /**
   * What a ferret spent, turn by turn, read through ITS harness (`Harness.usage`; Ferrets owns which harness a ferret
   * runs, so Usage never reaches one). Token counts only, never transcript text. `undefined` means PARTIAL: the ferret is
   * unknown, its harness is off, or the reader threw. It is never counted as zero; an empty list is a ferret that spent
   * nothing yet.
   */
  turnUsage(ferret: FerretId, since?: Instant): Promise<readonly TurnUsage[] | undefined>;
  /**
   * Additive (usage and Packs read it): the limits live ferrets' panes prove, one row per limited ferret, derived from
   * their state now (see {@link FerretPaneLimit}). A reader that wants them by login aggregates them (Usage owns that).
   */
  paneLimits?(): Promise<readonly FerretPaneLimit[]>;
}
