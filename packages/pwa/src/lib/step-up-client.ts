/**
 * The browser's half of the passkey routes (`docs/design/zero-trust.md` B2).
 *
 * Every call takes a client rather than building one: a passkey belongs to ONE machine, and one browser
 * can be paired to several. Nothing here is cached and nothing is logged — a challenge is single-use,
 * but there is still no reason for one to sit in a log.
 *
 * The app's own origin is sent with each options request because it IS the relying party: the daemon
 * checks it against the origins it serves and answers with the matching relying-party id, so a copy of
 * the app at another origin is told plainly that it needs its own passkey.
 */

import {
  type IFyApiClient,
  type PasskeyRegistration,
  type PasskeyRegistrationOptions,
  PasskeyRegistrationOptionsSchema,
  type PasskeysView,
  PasskeysViewSchema,
  type PasskeyView,
  PasskeyViewSchema,
  type UnlockGranted,
  UnlockGrantedSchema,
  type StepUpAct,
  type StepUpAssertion,
  type StepUpGranted,
  StepUpGrantedSchema,
  type StepUpOptions,
  StepUpOptionsSchema,
  type TwoFactorStageId,
} from '@ferretry/protocol';

/** The only client capability this surface uses. */
export type StepUpClient = Pick<IFyApiClient, 'request'>;

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** What this device holds, and whether it may add a passkey right now. */
export async function fetchPasskeys(client: StepUpClient): Promise<PasskeysView> {
  return await client.request('/v1/passkeys', PasskeysViewSchema, { method: 'GET' });
}

export async function passkeyRegistrationOptions(
  client: StepUpClient,
  origin: string,
): Promise<PasskeyRegistrationOptions> {
  return await client.request('/v1/passkeys/options', PasskeyRegistrationOptionsSchema, json({ origin }));
}

export async function registerPasskey(client: StepUpClient, registration: PasskeyRegistration): Promise<PasskeyView> {
  return await client.request('/v1/passkeys', PasskeyViewSchema, json(registration));
}

export async function stepUpOptions(
  client: StepUpClient,
  origin: string,
  act?: StepUpAct,
  subject?: TwoFactorStageId,
): Promise<StepUpOptions> {
  return await client.request(
    '/v1/step-up/options',
    StepUpOptionsSchema,
    json({ origin, ...(act === undefined ? {} : { act }), ...(subject === undefined ? {} : { subject }) }),
  );
}

export async function submitStepUp(client: StepUpClient, assertion: StepUpAssertion): Promise<StepUpGranted> {
  return await client.request('/v1/step-up', StepUpGrantedSchema, json(assertion));
}

/** Options for the passkey confirmation that opens the app (`unlockOnOpen`): same shape as a step-up's. */
export async function unlockOptions(client: StepUpClient, origin: string): Promise<StepUpOptions> {
  return await client.request('/v1/unlock/options', StepUpOptionsSchema, json({ origin }));
}

/** Submits that confirmation. It is never a step-up: the acts that need one still ask for their own. */
export async function submitUnlock(client: StepUpClient, assertion: StepUpAssertion): Promise<UnlockGranted> {
  return await client.request('/v1/unlock', UnlockGrantedSchema, json(assertion));
}
