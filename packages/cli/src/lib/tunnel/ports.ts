import type { IFyApiClient, TunnelStatusView } from '@ferretry/protocol';

/** Presentation for the tunnel commands. */
export interface ITunnelOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** The daemon calls the tunnel commands need. */
export interface ITunnelGateway {
  read(): Promise<TunnelStatusView>;
  change(enabled: boolean): Promise<TunnelStatusView>;
}

/** The only client capability the tunnel gateway consumes. */
export type TunnelApiClient = Pick<IFyApiClient, 'request'>;
