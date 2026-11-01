import type {
  CopyMeta,
  CopyPlan,
  CopyPlanList,
  IFyApiClient,
  PasteRule,
  PasteRuleCreate,
  PasteRuleList,
  PasteRuleSettingsView,
} from '@ferretry/protocol';

/** Presentation port for `fy copy`. */
interface ICopyOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}

/** The daemon calls `fy copy` needs: descriptions of copies, rules and plans. None of them carries a value. */
export interface ICopyGateway {
  copies(sessionId: string): Promise<readonly CopyMeta[]>;
  rules(): Promise<PasteRuleList>;
  /** The secure-copy settings and the rules a profile program could satisfy; rejects on a daemon without them. */
  ruleSettings(): Promise<PasteRuleSettingsView>;
  addRule(rule: PasteRuleCreate): Promise<PasteRule>;
  removeRule(id: string): Promise<void>;
  plans(): Promise<CopyPlanList>;
  approve(sessionId: string, planId: string, items: readonly number[]): Promise<CopyPlan>;
}

export type CopyApiClient = Pick<IFyApiClient, 'request'>;

export interface CopyPorts {
  readonly gateway: ICopyGateway;
  readonly out: ICopyOutput;
  /** `FY_SESSION_ID`: set when this CLI runs inside a ferret's pane. */
  readonly ownSessionId: string | undefined;
  /** `FY_SESSION_BOARD_CAPABILITY`: set when this CLI runs with an agent's credential. */
  readonly agentCredential: string | undefined;
}
