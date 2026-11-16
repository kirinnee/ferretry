/**
 * STAND-IN for a plugin contract this one may not import (§2.4 allows only Usage -> Logins, Packs -> Runtimes).
 * Agenda `uses` Access (§2.3) to send a buzz to the owner's phone; the token is Access's. The generator matches ports
 * by name, so this has the same name; replace with Access's token when its contract lands (ask the lead).
 */
import { definePort } from '@ferretry/kernel/contract';

export interface AccessBuzzApi {
  /** Sends one push to every live enrolment; resolves how many devices it reached. */
  buzz(message: {
    readonly tag: string;
    readonly title: string;
    readonly body: string;
    readonly url: string;
  }): Promise<number>;
  /**
   * Takes buzzes down on every enrolled device but the caller's (`except` is a paired device's id, read from the
   * credential): the buzz lines named by these tags. Resolves how many devices were told. Absent while Access offers
   * no clear: opening an ask then records that it was seen and cannot take the other devices' lines down.
   */
  clear?(tags: readonly string[], except?: string): Promise<number>;
}
export const AccessPort = definePort<AccessBuzzApi>('access');
