/**
 * STAND-INS for the ports Warden `uses` and cannot import (a new workspace dependency would change the Bun install
 * inputs and so the pinned Nix `outputHash`). §2.3: Usage, Logins and Accounts each provide the real port; the generator
 * matches ports by NAME, so each stand-in states only the members the Warden reads, structurally, and the provider's own
 * interface is assignable to it. Replace with the real contract imports when a dependency is added for another reason
 * (a manifest may import another contract; a contract file may not).
 */
import { definePort } from '@ferretry/kernel/contract';

/** What a ferret's pane proved about a login's limit, as Usage's `paneLimits` carries it. */
interface UsagePaneLimit {
  readonly login?: string;
  readonly runtime?: string;
  readonly notice: string;
  readonly spend: boolean;
  readonly retryAt?: number;
}

export interface UsageHeadroomApi {
  /** Percent of the quota left for a login, or `undefined` when unknown. */
  headroomPercent(login: string): Promise<number | undefined>;
  /** The limits live ferrets' panes prove (the Move's own "is this login out of quota" evidence). */
  paneLimits?(): Promise<readonly UsagePaneLimit[]>;
}
export const UsagePort = definePort<UsageHeadroomApi>('usage');

/** Logins' list; each row is read as `FleetCredentialView` (`daemon/lib/foreign-pack.ts`): its sign-in word, quota windows and budget. */
export interface LoginFactsApi {
  list(): Promise<{ readonly logins: readonly object[] }>;
}
export const LoginsPort = definePort<LoginFactsApi>('logins');

/** Accounts' one yes or no: is anything of the owner's open on this ferret? Never what, never a value. */
export interface OwnerHoldApi {
  ownerHold?(ferret: string): boolean;
}
export const AccountsPort = definePort<OwnerHoldApi>('accounts');
