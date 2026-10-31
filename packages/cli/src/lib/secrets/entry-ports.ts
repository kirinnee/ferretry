import type {
  IFyApiClient,
  LoginEntryList,
  LoginEntrySummary,
  LoginHintList,
  LoginRecipeDecision,
  PutLoginEntryRequest,
  RemovedLoginEntry,
} from '@ferretry/protocol';

/** The daemon calls `fy account` needs. There is no read: a summary never carries a value. */
export interface ILoginEntryGateway {
  list(): Promise<LoginEntryList>;
  /** Create the entry or change the fields named; a value travels IN here and nowhere else. */
  put(id: string, body: PutLoginEntryRequest): Promise<LoginEntrySummary>;
  rename(id: string, to: string): Promise<LoginEntrySummary>;
  remove(id: string): Promise<RemovedLoginEntry>;
  /** What a ferret may know about signing in to a site: labels, methods, domains, usernames. */
  hint(site: string): Promise<LoginHintList>;
  /** The owner's answer to one waiting recipe proposal; the entry as it stands after. */
  decideRecipe(id: string, proposalId: string, decision: LoginRecipeDecision['decision']): Promise<LoginEntrySummary>;
}

/**
 * The only ways a value enters these commands: a hidden read from a terminal a person is sitting at.
 * `IPrompt` satisfies it structurally. No flag, argument, environment variable or pipe supplies one.
 */
export interface ILoginEntryPrompt {
  ask(message: string): Promise<string>;
  askHidden(message: string): Promise<string>;
}

interface ILoginEntryOutput {
  success(message: string): void;
}

/** The only client capability the login entry gateway consumes. */
export type LoginEntryApiClient = Pick<IFyApiClient, 'request'>;

/** Everything a `fy account` run needs besides its words and flags. */
export interface LoginEntryPorts {
  readonly gateway: ILoginEntryGateway;
  readonly out: ILoginEntryOutput;
  readonly prompt: ILoginEntryPrompt;
  /** Whether stdin and stdout are a terminal a person is typing at. */
  readonly interactive: boolean;
  /** A recipe's Markdown from a file path, or from standard input when the source is `-`. */
  readonly readRecipe: (source: string) => Promise<string>;
}
