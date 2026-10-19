import type { IFyApiClient } from '@ferretry/protocol';

/** The one daemon call slice `fy models` needs: the protocol client's own `request`. */
export type IModelsGateway = Pick<IFyApiClient, 'request'>;

/** Presentation port — the narrowest slice of the shipped `ConsoleIo` this context uses. */
export interface IModelsOutput {
  success(message: string): void;
}
