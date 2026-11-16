import type { FerretState as SessionStatus, FerretSummary } from '../../../contract/index.ts';

/**
 * Bulk stop stays entirely client-side: every mutation is the ordinary per-session stop call, so
 * these selectors add no authorization surface and never turn the shared bearer into a batch
 * capability the daemon would have to reason about.
 */
export type BulkStopSelector =
  | { readonly kind: 'orphan'; readonly rootId: string }
  | { readonly kind: 'cascade'; readonly rootId: string }
  | { readonly kind: 'children'; readonly rootId: string }
  | { readonly kind: 'label'; readonly label: string };

/** One session as the stop plan sees it — identity, lineage position, and caller relationship. */
export interface StopTarget {
  readonly id: string;
  readonly name: string;
  readonly teammate?: string;
  readonly label?: string;
  readonly parent?: string;
  readonly status: SessionStatus;
  readonly depth: number;
  /** True when this is the session issuing the command. */
  readonly caller: boolean;
  /** True when this session is an ancestor of the caller — its probable lead. */
  readonly callerAncestor: boolean;
}

export interface StopPlan {
  readonly selector: BulkStopSelector;
  /** Every stoppable session the selector matched, before the caller safety exclusion. */
  readonly candidates: readonly StopTarget[];
  /** The exact ordered set the confirmation authorizes. */
  readonly targets: readonly StopTarget[];
  /** Normally zero or one entry: the issuing session is excluded unless asked for explicitly. */
  readonly excluded: readonly StopTarget[];
  /** ORPHAN only: live descendants deliberately left running and parentless. */
  readonly leftRunning: readonly StopTarget[];
  readonly callerId?: string;
}

export interface StopOutcome {
  readonly target: StopTarget;
  readonly ok: boolean;
  readonly status?: string;
  readonly error?: string;
}

export interface StopSweepResult {
  readonly kind: BulkStopSelector['kind'];
  readonly outcomes: readonly StopOutcome[];
  /** Matching stoppable sessions that were absent from the confirmed candidate set. */
  readonly appeared: readonly StopTarget[];
  /** ORPHAN only: the live descendants observed after the selected stop. */
  readonly leftRunning: readonly StopTarget[];
  /** ORPHAN only: descendants that were not in the confirmation-time list. */
  readonly appearedLeftRunning: readonly StopTarget[];
  readonly raceCheckError?: string;
}

export interface BulkStopOptions {
  readonly reason?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly includeCaller?: boolean;
}

export interface BulkStopResult {
  readonly exitCode: number;
  readonly plan?: StopPlan;
  readonly sweep?: StopSweepResult;
  readonly confirmed: boolean;
}

/**
 * The daemon calls the bulk stop controller needs: the fleet list, one ferret, one stop. Every mutation is the
 * ordinary per-ferret stop, so bulk stop adds no authorization surface.
 */
export interface IStopSessionGateway {
  list(): Promise<readonly FerretSummary[]>;
  /** One ferret, by id or name: the daemon resolves the name, exactly as a single stop would. */
  get(reference: string): Promise<FerretSummary>;
  stop(id: string, reason?: string): Promise<{ readonly id: string; readonly state?: string }>;
}

/** Presentation port: satisfied structurally by the shipped `ConsoleIo` terminal adapter. */
export interface IStopIo {
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Interactive-input port: satisfied structurally by the shipped `InquirerPrompt` adapter. */
export interface IStopPrompt {
  ask(message: string): Promise<string>;
}

/** What the command surface needs from the controller — keeps argv wiring testable without doubles of IO. */
export interface IBulkStopRunner {
  run(selector: BulkStopSelector, options: BulkStopOptions): Promise<BulkStopResult>;
}
