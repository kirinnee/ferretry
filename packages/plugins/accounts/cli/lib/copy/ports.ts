import type {
  CopyMeta,
  DaemonId,
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
} from '../../../contract/routes/index.ts';
import type { DaemonCaller } from '../../shell.ts';

/** Presentation port for `fy copy` and `fy plan`. */
interface ICopyOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}

/** The daemon calls `fy copy` needs: descriptions of copies and rules. None of them carries a value. */
export interface ICopyGateway {
  copies(sessionId: string): Promise<readonly CopyMeta[]>;
  rules(): Promise<PasteRuleList>;
  /** The secure-copy settings and the rules a profile program could satisfy. */
  ruleSettings(): Promise<PasteRuleSettingsView>;
  /**
   * `PUT /v1/copy-rules/settings`: the settings as the daemon now keeps them. Used to turn `allowProfileTargets` OFF;
   * turning it on is staged ({@link stageProfileTargets}) and confirmed with a passkey.
   */
  changeRuleSettings(settings: PasteRuleSettings): Promise<PasteRuleSettings>;
  /**
   * STAGES a paste rule (owner decision !A244). There is NO commit here, on purpose: a paste rule is made only with a
   * passkey bound to its stage, which the machine's token cannot prove, so the owner commits it in the app.
   */
  stageRule(rule: PasteRuleCreate): Promise<PasteRuleStaged>;
  /** STAGES turning on programs in your own profile, with the rules it widens; the owner approves it in the app. */
  stageProfileTargets(): Promise<PasteRuleStaged>;
  /** Where a staged paste rule stands, for the wait. */
  ruleStage(stage: string): Promise<PasteRuleStageView>;
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
}

export type CopyApiClient = DaemonCaller;

/** Who is running the command: the same two facts decide that it is a ferret and refuse it. */
interface CallerPorts {
  /** `FY_SESSION_ID`: set when this CLI runs inside a ferret's pane. */
  readonly ownSessionId: string | undefined;
  /** The agent's credential in this pane's environment (see `paneCredentialMarker`). */
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
  /** This daemon's id, which the link names so the app opens the machine that holds the card; absent or failing, none. */
  readonly machine?: (() => Promise<DaemonId | undefined>) | undefined;
  /** Hands a link to this host's browser; resolves to whether one was launched. */
  readonly openLink?: ((url: string) => Promise<boolean>) | undefined;
  readonly nowMs: () => number;
}
