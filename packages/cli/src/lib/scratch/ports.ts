import type { IFyApiClient } from '@ferretry/protocol';

/** The two scratch-reclamation calls already owned and validated by the protocol client. */
export type IScratchGateway = Pick<IFyApiClient, 'scratchPlan' | 'scratchSweep'>;

/** Terminal output used by the scratch command. */
export interface IScratchOutput {
  success(message: string): void;
}
