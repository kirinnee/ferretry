import type { IFyApiClient, PinActionRequest, PinSnapshot } from '@ferretry/protocol';

/**
 * Presentation port for the pin commands. It is deliberately the narrowest slice of the shipped
 * `ConsoleIo` adapter that this context uses, so the production adapter satisfies it structurally
 * and no second terminal adapter has to exist. Failures travel as thrown errors — the composition
 * root owns turning those into stderr plus a non-zero exit code.
 */
export interface IPinOutput {
  success(message: string): void;
}

/**
 * The daemon calls the pin commands need. Declared here so the controller never sees a URL, a verb
 * or a status code: the CLI reaches `fyd` only over the protocol client.
 */
export interface IPinGateway {
  /** Read the target session's pin board. */
  list(sessionId: string): Promise<PinSnapshot>;
  /** Apply one pin mutation and return the board as the daemon left it. */
  apply(sessionId: string, request: PinActionRequest): Promise<PinSnapshot>;
}

/** The only client capability the pin gateway consumes. */
export type PinApiClient = Pick<IFyApiClient, 'request'>;
