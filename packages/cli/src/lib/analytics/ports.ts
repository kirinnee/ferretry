import type { IFyApiClient } from '@ferretry/protocol';

/**
 * Presentation port for the analytics command — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally. Failures travel as
 * thrown errors; the composition root turns those into stderr and a non-zero exit code.
 */
export interface IAnalyticsOutput {
  success(message: string): void;
}

/**
 * The daemon call the analytics command needs. The protocol client already owns the route and the
 * response schema, so this context asks for exactly that one method and nothing wider.
 */
export type IAnalyticsGateway = Pick<IFyApiClient, 'analytics'>;
