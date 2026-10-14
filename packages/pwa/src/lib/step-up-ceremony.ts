/**
 * The step-up ceremony for one machine, and what a person is told when it does not work.
 *
 * Options from the daemon, the passkey sheet, the daemon's verdict — in that order, with the app's own
 * origin as the relying party. Every failure becomes ONE plain sentence; a raw `NotAllowedError` or an
 * HTTP status is never what a person reads.
 */

import { type StepUpRefusal, stepUpRefusalCode } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { DaemonConnection } from './daemon-connection.ts';
import { assertPasskey, type CredentialsPort, PasskeyCeremonyError, passkeySentence } from './passkeys.ts';
import { unlockOptions, type StepUpClient, stepUpOptions, submitUnlock, submitStepUp } from './step-up-client.ts';

export interface StepUpCeremonyDependencies {
  readonly client: (daemon: DaemonConnection) => Promise<StepUpClient>;
  readonly credentials: CredentialsPort;
  /** This copy of the app's origin — the relying party a passkey answers for. */
  readonly origin: string;
}

export const stepUpCeremony =
  (deps: StepUpCeremonyDependencies) =>
  async (daemon: DaemonConnection): Promise<void> => {
    const client = await deps.client(daemon);
    const options = await stepUpOptions(client, deps.origin);
    const assertion = await assertPasskey(deps.credentials, options);
    await submitStepUp(client, assertion);
  };

/** The same ceremony for the confirmation that opens the app: its own two routes, no rotation, no step-up. */
export const unlockCeremony =
  (deps: StepUpCeremonyDependencies) =>
  async (daemon: DaemonConnection): Promise<void> => {
    const client = await deps.client(daemon);
    const options = await unlockOptions(client, deps.origin);
    const assertion = await assertPasskey(deps.credentials, options);
    await submitUnlock(client, assertion);
  };

const refusalWith = (reason: unknown, refusal: StepUpRefusal): boolean =>
  reason instanceof FyHttpError && reason.code === stepUpRefusalCode(refusal);

/** The one sentence for a failed ceremony. */
export const describeStepUpFailure =
  (origin: string) =>
  (reason: unknown): string => {
    if (reason instanceof PasskeyCeremonyError) return passkeySentence(reason.kind, origin);
    if (refusalWith(reason, 'no-passkey')) return passkeySentence('no-passkey', origin);
    if (refusalWith(reason, 'origin-not-allowed'))
      return `This machine does not serve the copy of the app at ${origin}. Open Ferretry at an address the machine lists, or add ${origin} to its corsOrigins.`;
    if (refusalWith(reason, 'not-verified')) return 'That passkey confirmation did not check out. Try again.';
    return reason instanceof Error ? reason.message : 'The passkey confirmation did not finish. Try again.';
  };

/**
 * The browser's own credential container, bound at the call so `navigator.credentials` keeps its
 * receiver — a WebIDL method called with the wrong `this` throws before any prompt appears.
 */
export const browserCredentials = (): CredentialsPort => ({
  create: options => navigator.credentials.create(options),
  get: options => navigator.credentials.get(options),
});
