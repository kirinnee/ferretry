import type { AttentionActionRequest, AttentionSnapshot, IFyApiClient } from '@ferretry/protocol';

/**
 * Presentation port for the attention commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally. Failures travel as
 * thrown errors; the composition root turns those into stderr and a non-zero exit code.
 */
export interface IAttentionOutput {
  success(message: string): void;
  /** A line for stderr: said to whoever runs the command, never mixed into its output. */
  diagnostic(message: string): void;
}

/**
 * The daemon calls the attention commands need. Declared here so the controller never sees a URL or a
 * status code: the CLI reaches `fyd` only over the protocol client.
 */
export interface IAttentionGateway {
  /** Read the target session's attention board, active items and resolutions together. */
  snapshot(sessionId: string): Promise<AttentionSnapshot>;
  /** Raise, resolve or dismiss an item and return the board as the daemon left it. */
  apply(sessionId: string, request: AttentionActionRequest): Promise<AttentionSnapshot>;
  /** Deliver the answers held for the ferret now, skipping the settle window; the board as it was left. */
  sendReplies(sessionId: string): Promise<AttentionSnapshot>;
}

/** The only client capability the attention gateway consumes. */
export type AttentionApiClient = Pick<IFyApiClient, 'request'>;

/** Reads the JSON body `fy agenda add --json-file <path>` names; `-` is standard input. */
export interface IAttentionBriefInput {
  read(path: string): Promise<string>;
}
