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
}
export const AccessPort = definePort<AccessBuzzApi>('access');
