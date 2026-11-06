import type {
  AgendaActionRequest,
  AgendaClearAgentsResult,
  AgendaListSnapshot,
  AgendaReadItem,
  IFyApiClient,
  TaskRef,
} from '@ferretry/protocol';

/**
 * Presentation port for the agenda commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally. Failures travel as
 * thrown errors; the composition root turns those into stderr and a non-zero exit code.
 */
export interface IAgendaOutput {
  success(message: string): void;
  /** A line for stderr: said to whoever runs the command, never mixed into its output. */
  diagnostic(message: string): void;
}

/**
 * The daemon calls the agenda commands need. Declared here so the controller never sees a URL or a
 * status code: the CLI reaches `fyd` only over the protocol client.
 */
export interface IAgendaGateway {
  /** Read the target session's agenda board, active items and resolutions together. */
  snapshot(sessionId: string): Promise<AgendaListSnapshot>;
  /** Complete document for a projected list entry. Optional for older embedded clients. */
  readItem?(sessionId: string, id: string): Promise<AgendaReadItem>;
  /** Raise, resolve or dismiss an item and return the board as the daemon left it. */
  apply(sessionId: string, request: AgendaActionRequest): Promise<AgendaListSnapshot>;
  /** Deliver the answers held for the ferret now, skipping the settle window; the board as it was left. */
  sendReplies(sessionId: string): Promise<AgendaListSnapshot>;
  /** The owner's bulk clear of the agent ferrets' open items; `dryRun` only counts them. */
  clearAgents(dryRun: boolean): Promise<AgendaClearAgentsResult>;
  /** The features the daemon reports (`DAEMON_FEATURES`); throws `DaemonFeaturesUnreadable` when it cannot be asked. */
  features(): Promise<readonly string[]>;
}

/** Asking the person at the terminal; `interactive` is false when nobody can answer. */
export interface IAgendaPrompt {
  interactive(): boolean;
  ask(message: string): Promise<string>;
}

/** The only client capability the attention gateway consumes. */
export type AgendaApiClient = Pick<IFyApiClient, 'request'>;

/** Reads the JSON body `fy agenda add --json-file <path>` names; `-` is standard input. */
export interface IAgendaBriefInput {
  read(path: string): Promise<string>;
}

/**
 * What a card is tied to on the board: the cards it depends on, and the cards that depend on it. `fy agenda add --task`
 * reads it so an open agenda carrying a tied card is listed first (dependent things share one agenda); `undefined`
 * when the board cannot say, which never stops an add.
 */
export interface IAgendaCardTies {
  ties(
    card: TaskRef,
  ): Promise<{ readonly dependsOn: readonly TaskRef[]; readonly blocks: readonly TaskRef[] } | undefined>;
}
