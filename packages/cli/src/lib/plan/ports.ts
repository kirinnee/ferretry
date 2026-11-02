import type {
  CopyMeta,
  IFyApiClient,
  PasteRule,
  PasteRuleCreate,
  PasteRuleList,
  PasteRuleSettings,
  PasteRuleSettingsView,
  PasteRuleStaged,
  PasteRuleStageView,
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
  /**
   * `PUT /v1/copy-rules/settings`: the settings as the daemon now keeps them. Turning `allowProfileTargets` on from a
   * governed (remote) caller is refused with `403 grant_step_up_required` until a passkey confirms that one act.
   */
  changeRuleSettings(settings: PasteRuleSettings): Promise<PasteRuleSettings>;
  /** The one-step create, for a daemon that does not report `copy-rules.passkey.1`. */
  addRule(rule: PasteRuleCreate): Promise<PasteRule>;
  /**
   * STAGES a paste rule (owner decision !A244). There is NO commit here, on purpose: a paste rule is made only with a
   * passkey bound to its stage, which the machine's token cannot prove, so the owner commits it in the app.
   */
  stageRule(rule: PasteRuleCreate): Promise<PasteRuleStaged>;
  /** Where a staged paste rule stands, for the wait. */
  ruleStage(stage: string): Promise<PasteRuleStageView>;
  removeRule(id: string): Promise<void>;
  /** The features the daemon reports (`DAEMON_FEATURES`); throws `DaemonFeaturesUnreadable` when it cannot be asked. */
  features(): Promise<readonly string[]>;
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
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
}

export interface PlanPorts extends CallerPorts {
  readonly gateway: IPlanGateway;
  readonly out: ICopyOutput;
  readonly sleep: (ms: number) => Promise<void>;
  /** The app's address, where a plan's card is opened (`<origin>/#agenda/<id>?session=<sid>`); absent, no link is printed. */
  readonly appOrigin?: string | undefined;
  /** Said with the link when a set app address was refused and the hosted one stands. */
  readonly appOriginNote?: string | undefined;
  /** Hands a link to this host's browser; resolves to whether one was launched. */
  readonly openLink?: ((url: string) => Promise<boolean>) | undefined;
  readonly nowMs: () => number;
}
