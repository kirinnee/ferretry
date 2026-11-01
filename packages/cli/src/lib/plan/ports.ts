import type {
  CopyMeta,
  IFyApiClient,
  PasteRule,
  PasteRuleCreate,
  PasteRuleList,
  PasteRuleSettingsView,
  TaskPlan,
  TaskPlanApproval,
  TaskPlanApprovalAnswer,
  TaskPlanConfirming,
  TaskPlanList,
  TaskPlanStageView,
} from '@ferretry/protocol';

/** Presentation port for `fy copy` and `fy plan`. */
interface ICopyOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}

/** The daemon calls `fy copy` needs: descriptions of copies and rules. None of them carries a value. */
export interface ICopyGateway {
  copies(sessionId: string): Promise<readonly CopyMeta[]>;
  rules(): Promise<PasteRuleList>;
  /** The secure-copy settings and the rules a profile program could satisfy; rejects on a daemon without them. */
  ruleSettings(): Promise<PasteRuleSettingsView>;
  addRule(rule: PasteRuleCreate): Promise<PasteRule>;
  removeRule(id: string): Promise<void>;
}

/**
 * The daemon calls `fy plan` needs. There is NO commit here, on purpose: a sign-in line is committed only with a
 * passkey proof the machine cannot make, so this CLI stages a selection and the owner commits it in the app.
 */
export interface IPlanGateway {
  plans(session?: string): Promise<TaskPlanList>;
  stage(sessionId: string, planId: string, approval: TaskPlanApproval): Promise<TaskPlanApprovalAnswer>;
  confirmInApp(sessionId: string, planId: string, stage: string): Promise<TaskPlanConfirming>;
  view(sessionId: string, planId: string, stage: string): Promise<TaskPlanStageView>;
  revoke(sessionId: string, planId: string, lines?: readonly number[]): Promise<TaskPlan>;
  /** The features the daemon reports (`DAEMON_FEATURES`); empty when it reports none or cannot be asked. */
  features(): Promise<readonly string[]>;
}

export type CopyApiClient = Pick<IFyApiClient, 'request'>;

/** Who is running the command: the same two facts decide that it is a ferret and refuse it. */
interface CallerPorts {
  /** `FY_SESSION_ID`: set when this CLI runs inside a ferret's pane. */
  readonly ownSessionId: string | undefined;
  /** `FY_SESSION_BOARD_CAPABILITY`: set when this CLI runs with an agent's credential. */
  readonly agentCredential: string | undefined;
}

export interface CopyPorts extends CallerPorts {
  readonly gateway: ICopyGateway;
  readonly out: ICopyOutput;
}

export interface PlanPorts extends CallerPorts {
  readonly gateway: IPlanGateway;
  readonly out: ICopyOutput;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
}
