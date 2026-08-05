import type { StateHomeClaimService } from './claim.ts';
import { renderAdoption, renderAdoptionJson } from './render.ts';

/** Terminal output for the adopt verb — the narrowest slice of the shipped writer it uses. */
export interface IStateHomeOutput {
  success(message: string): void;
}

/** Options the adopt verb accepts, matching its siblings in the daemon group. */
export interface StateHomeAdoptOptions {
  readonly json?: boolean;
}

/**
 * Drives `fy daemon adopt`: claims a state home that Ferretry created before claims existed.
 *
 * This is the upgrade path, not a convenience. Every home provisioned by a release before the claim
 * landed carries no marker, so the daemon refuses it permanently — and the only move that release
 * left an owner was to delete the installation they had just set up. A refusal that names a repair
 * is only honest if the repair exists.
 */
export class StateHomeController {
  constructor(
    private readonly claims: StateHomeClaimService,
    private readonly home: string,
    private readonly out: IStateHomeOutput,
  ) {}

  async adopt(options: StateHomeAdoptOptions): Promise<void> {
    const adoption = await this.claims.adopt(this.home);
    this.out.success(options.json === true ? renderAdoptionJson(adoption) : renderAdoption(adoption));
  }
}
