import type {
  AccountList,
  AccountLookAlike,
  AccountHintList,
  AccountSummary,
  AddSignInRequest,
  AddTwoFactorKeyRequest,
  IFyApiClient,
  LoginRecipeDecision,
  PutAccountDefaultRequest,
  PutAccountDefaultResult,
  PutAccountRequest,
  PutSignInRequest,
  RemovedAccount,
  RemovedSignIn,
  RemovedTwoFactorKey,
  SignInSummary,
  TwoFactorKeySummary,
} from '@ferretry/protocol';

/**
 * The daemon calls `fy account` needs, over `/v1/accounts*`. There is no read of a value: a summary never carries one.
 * Every write is the OWNER's (a person route): the daemon refuses a ferret, and nothing here retries with another
 * credential.
 */
export interface IAccountGateway {
  list(): Promise<AccountList>;
  /** Create the account or change the fields named; a password travels IN here and nowhere else. */
  putAccount(id: string, body: PutAccountRequest): Promise<AccountSummary>;
  renameAccount(id: string, to: string): Promise<AccountSummary>;
  removeAccount(id: string): Promise<RemovedAccount>;
  /** Fold `from` into `id`: its sign-ins and 2FA keys move; the daemon refuses different seeds or an overlapping place. */
  merge(id: string, from: string): Promise<AccountSummary>;
  /** Record that `id` and `from` are NOT one account, so they are never offered as look-alikes of each other. */
  apart(id: string, from: string): Promise<AccountSummary>;
  lookAlike(): Promise<AccountLookAlike>;
  /** What a ferret may know about signing in to a site, one entry per sign-in. */
  hint(site: string): Promise<AccountHintList>;
  addSignIn(account: string, body: AddSignInRequest): Promise<SignInSummary>;
  putSignIn(signIn: string, body: PutSignInRequest): Promise<SignInSummary>;
  removeSignIn(signIn: string): Promise<RemovedSignIn>;
  /** The owner's answer to one waiting recipe proposal; the sign-in as it stands after. */
  decideRecipe(signIn: string, proposalId: string, decision: LoginRecipeDecision['decision']): Promise<SignInSummary>;
  /** The owner route: one line of `config/account-defaults.yaml`, or `account: null` to remove it. */
  putDefault(body: PutAccountDefaultRequest): Promise<PutAccountDefaultResult>;
  /** A 2FA key with no value (sms, email, push, security key, an authenticator only the owner holds). */
  addFactor(account: string, body: AddTwoFactorKeyRequest): Promise<TwoFactorKeySummary>;
  removeFactor(account: string, factor: string): Promise<RemovedTwoFactorKey>;
}

/**
 * The only ways a value enters these commands: a hidden read from a terminal a person is sitting at.
 * `IPrompt` satisfies it structurally. No flag, argument, environment variable or pipe supplies one.
 */
export interface IAccountPrompt {
  ask(message: string): Promise<string>;
  askHidden(message: string): Promise<string>;
}

interface IAccountOutput {
  success(message: string): void;
}

/** The only client capability the account gateway consumes. */
export type AccountApiClient = Pick<IFyApiClient, 'request'>;

/** Everything a `fy account` run needs besides its words and flags. */
export interface AccountPorts {
  readonly gateway: IAccountGateway;
  readonly out: IAccountOutput;
  readonly prompt: IAccountPrompt;
  /** Whether stdin and stdout are a terminal a person is typing at. */
  readonly interactive: boolean;
  /** A recipe's Markdown from a file path, or from standard input when the source is `-`. */
  readonly readRecipe: (source: string) => Promise<string>;
}
