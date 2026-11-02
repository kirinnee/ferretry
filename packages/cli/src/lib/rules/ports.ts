import type {
  IFyApiClient,
  SignInRuleDraft,
  SignInRuleEligibility,
  SignInRuleList,
  SignInRuleNarrow,
  SignInRuleStaged,
  SignInRuleStageView,
  SignInRuleView,
} from '@ferretry/protocol';

/** Presentation port for `fy rules`. */
interface IRulesOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}

/**
 * The daemon calls `fy rules` needs. There is NO commit here, on purpose: a standing rule is committed only with a
 * passkey proof the machine cannot make, so this CLI stages a draft and the owner commits it in the app.
 */
export interface IRulesGateway {
  list(): Promise<SignInRuleList>;
  stage(draft: SignInRuleDraft): Promise<SignInRuleStaged>;
  confirmInApp(stage: string): Promise<SignInRuleStaged>;
  view(stage: string): Promise<SignInRuleStageView>;
  drop(stage: string): Promise<void>;
  narrow(rule: string, narrow: SignInRuleNarrow): Promise<SignInRuleView>;
  revoke(rule: string): Promise<void>;
  /** Ends every rule of one account (`POST /v1/accounts/:id/sign-in-rules/revoke`): how many it ended. */
  revokeAccount(account: string): Promise<number>;
  /** Whether the owner could make a rule for this sign-in now, and why not. */
  eligibility(signIn: string): Promise<SignInRuleEligibility>;
  /** The features the daemon reports (`DAEMON_FEATURES`); empty when it reports none or cannot be asked. */
  features(): Promise<readonly string[]>;
}

export type RulesApiClient = Pick<IFyApiClient, 'request'>;

export interface RulesPorts {
  readonly gateway: IRulesGateway;
  readonly out: IRulesOutput;
  /** `FY_SESSION_ID`: set when this CLI runs inside a ferret's pane. */
  readonly ownSessionId: string | undefined;
  /** The agent's credential in this pane's environment (see `paneCredentialValue`). */
  readonly agentCredential: string | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nowMs: () => number;
  /** Draws a red warning; the identity when colour is off. */
  readonly red: (text: string) => string;
  /** The app's address, where a staged rule is confirmed (`<origin>/#rules/<stage>`); absent, no link is printed. */
  readonly appOrigin?: string | undefined;
  /** Said with the link when a set app address was refused and the hosted one stands. */
  readonly appOriginNote?: string | undefined;
  /** Hands a link to this host's browser; resolves to whether one was launched. */
  readonly openLink?: ((url: string) => Promise<boolean>) | undefined;
}
