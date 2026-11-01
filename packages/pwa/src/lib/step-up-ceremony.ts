/**
 * The step-up ceremony for one machine, and what a person is told when it does not work.
 *
 * Options from the daemon, the passkey sheet, the daemon's verdict — in that order, with the app's own
 * origin as the relying party. Every failure becomes ONE plain sentence; a raw `NotAllowedError` or an
 * HTTP status is never what a person reads.
 */

import { type PasskeyView, type StepUpAct, type StepUpRefusal, stepUpRefusalCode } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { DaemonConnection } from './daemon-connection.ts';
import {
  assertPasskey,
  type CredentialsPort,
  createPasskey,
  PasskeyCeremonyError,
  passkeySentence,
} from './passkeys.ts';
import {
  fetchPasskeys,
  passkeyRegistrationOptions,
  registerPasskey,
  type StepUpClient,
  stepUpOptions,
  submitStepUp,
  submitUnlock,
  unlockOptions,
} from './step-up-client.ts';
import type { StepUpSubject } from './step-up-gate.ts';

export interface StepUpCeremonyDependencies {
  readonly client: (daemon: DaemonConnection) => Promise<StepUpClient>;
  readonly credentials: CredentialsPort;
  /** This copy of the app's origin — the relying party a passkey answers for. */
  readonly origin: string;
}

export const stepUpCeremony =
  (deps: StepUpCeremonyDependencies) =>
  async (daemon: DaemonConnection, act?: StepUpAct, subject?: StepUpSubject): Promise<void> => {
    const client = await deps.client(daemon);
    const options = await stepUpOptions(client, deps.origin, act, subject);
    const assertion = await assertPasskey(deps.credentials, options);
    await submitStepUp(client, assertion);
  };

/**
 * The same ceremony for the confirmation that opens the app: its own two routes, no rotation, no step-up.
 *
 * A DEVICE WITH NO PASSKEY YET ADDS ITS FIRST ONE, THEN UNLOCKS WITH IT. Inside its first-passkey window
 * (ten minutes from pairing, or one the owner reopened) that is the whole way in, and telling it to "add
 * one from a device that already has access" sent a person away from the one thing they could do. Once
 * the window has closed the registration is refused, and that refusal is the sentence they are shown.
 */
export const unlockCeremony =
  (deps: StepUpCeremonyDependencies) =>
  async (daemon: DaemonConnection): Promise<void> => {
    const client = await deps.client(daemon);
    const options = await unlockOptions(client, deps.origin).catch(async (reason: unknown) => {
      // The machine holds no passkey for this copy of the app: add the first one, then ask again.
      if (!refusalWith(reason, 'no-passkey')) throw reason;
      await addPasskeyCeremony(deps.credentials, client, deps.origin);
      return await unlockOptions(client, deps.origin);
    });
    const assertion = await assertPasskey(deps.credentials, options);
    await submitUnlock(client, assertion);
  };

/** Whether this device can only get in by adding its first passkey — which its window lets it do now. */
export const firstPasskeyOffer =
  (client: (daemon: DaemonConnection) => Promise<StepUpClient>) =>
  async (daemon: DaemonConnection): Promise<boolean> => {
    const view = await fetchPasskeys(await client(daemon));
    return view.passkeys.length === 0 && (view.registration === 'first-window' || view.registration === 'reopened');
  };

/**
 * Add a passkey in ONE ceremony. A device that already holds a passkey must first answer the options'
 * `confirm` with it (an assertion), then create the new one; the registration carries that assertion so
 * the daemon can bind the two. A first passkey carries no `confirm` and so asks for no assertion.
 * A dismissed assertion ends the ceremony before any creation prompt appears.
 */
export async function addPasskeyCeremony(
  credentials: CredentialsPort,
  client: StepUpClient,
  origin: string,
  supported?: boolean,
): Promise<PasskeyView> {
  const options = await passkeyRegistrationOptions(client, origin);
  const confirmation =
    options.confirm === undefined ? undefined : await assertPasskey(credentials, options.confirm, supported);
  const registration = await createPasskey(credentials, options, supported);
  return await registerPasskey(client, { ...registration, ...(confirmation === undefined ? {} : { confirmation }) });
}

const refusalWith = (reason: unknown, refusal: StepUpRefusal): boolean =>
  reason instanceof FyHttpError && reason.code === stepUpRefusalCode(refusal);

/** The one sentence for a failed ceremony. */
export const describeStepUpFailure =
  (origin: string) =>
  (reason: unknown): string => {
    if (reason instanceof PasskeyCeremonyError) return passkeySentence(reason.kind, origin);
    if (refusalWith(reason, 'no-passkey') || refusalWith(reason, 'registration-closed'))
      return passkeySentence('no-passkey', origin);
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
