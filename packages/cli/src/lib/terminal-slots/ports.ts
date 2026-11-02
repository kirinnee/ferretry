import type { IFyApiClient } from '@ferretry/protocol';

/** The one daemon call the terminal-slot commands need: a typed request to a route. */
export type ITerminalSlotsGateway = Pick<IFyApiClient, 'request'>;
