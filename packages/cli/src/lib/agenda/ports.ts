import type { AgendaActionRequest, AgendaSnapshot, IFyApiClient } from '@ferretry/protocol';

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
  snapshot(sessionId: string): Promise<AgendaSnapshot>;
  /** Raise, resolve or dismiss an item and return the board as the daemon left it. */
  apply(sessionId: string, request: AgendaActionRequest): Promise<AgendaSnapshot>;
  /** Deliver the answers held for the ferret now, skipping the settle window; the board as it was left. */
  sendReplies(sessionId: string): Promise<AgendaSnapshot>;
  /** The features the daemon reports (`DAEMON_FEATURES`); empty when it reports none or cannot be asked. */
  features(): Promise<readonly string[]>;
}

/** The only client capability the attention gateway consumes. */
export type AgendaApiClient = Pick<IFyApiClient, 'request'>;

/** Reads the JSON body `fy agenda add --json-file <path>` names; `-` is standard input. */
export interface IAgendaBriefInput {
  read(path: string): Promise<string>;
}
