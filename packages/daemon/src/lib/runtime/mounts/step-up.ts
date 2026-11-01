/**
 * THE PASSKEY STEP-UP SURFACE (`docs/design/zero-trust.md` B2).
 *
 * Eight routes. Seven are for a paired DEVICE, inside a session its key opened: what this device holds, the
 * three ceremonies (register a passkey, unlock, step up) with their options. The eighth is the owner's
 * re-opened window. The browser runs WebAuthn; the daemon issues the challenge and verifies the answer, so
 * a relay carrying these records can neither forge an assertion nor replay one.
 *
 * NO CAPABILITY DEMAND, deliberately. These routes are how a device PROVES itself, and gating the proof
 * behind a grant would let a switched-off capability lock the owner out of the very ceremony that
 * re-opens it. What they hand out is bounded instead: a step-up is fifteen minutes for one running copy
 * of the app, it widens nothing a grant refused, and adding a passkey has its own ceremony — never a
 * step-up, and never authorized by one (see `StepUpService`).
 *
 * WHO the caller is comes from the session — `request.device`, set by the tunnel that verified the
 * device key — and WHERE it arrived from the boundary's own proof. Neither is ever read from a body.
 */

import {
  PasskeyOptionsRequestSchema,
  PasskeyRegistrationOptionsSchema,
  PasskeyRegistrationSchema,
  PasskeysViewSchema,
  PasskeyViewSchema,
  UnlockGrantedSchema,
  PasskeyWindowOpenedSchema,
  PasskeyWindowRequestSchema,
  STEP_UP_ACTS,
  StepUpAssertionSchema,
  StepUpGrantedSchema,
  StepUpOptionsSchema,
  type StepUpRefusal,
  StepUpOptionsRequestSchema,
  stepUpRefusalCode,
  TWO_FACTOR_ERROR_CODES,
  type TwoFactorStageId,
} from '@ferretry/protocol';
import {
  type ApiResponse,
  type ApiRoute,
  arrivedOnHost,
  errorResponse,
  jsonResponse,
  parseBody,
  type RouteContext,
} from '../../api/index.ts';
import type { StepUpCaller, StepUpOutcome, StepUpService } from '../../step-up/index.ts';

/** The status and sentence for each refusal. A sentence names the person's next step, never a value. */
const REFUSALS: Readonly<Record<StepUpRefusal, { readonly status: number; readonly message: string }>> = {
  'not-a-device': { status: 400, message: 'a passkey belongs to a paired device, and this caller is not one' },
  'origin-not-allowed': {
    status: 403,
    message: 'this copy of the app is not one this machine serves; add its origin to corsOrigins on the machine',
  },
  'registration-closed': {
    status: 403,
    message:
      'a new passkey can only be added within ten minutes of pairing, by confirming with a passkey this device already holds, or after the owner runs `fy passkey window <device>` at the machine',
  },
  'too-many-passkeys': { status: 409, message: 'this device already holds as many passkeys as it may' },
  'no-passkey': { status: 404, message: 'this copy of the app has no passkey for this machine' },
  'not-verified': { status: 401, message: 'that passkey confirmation did not check out; try again' },
  'rotation-required': {
    status: 403,
    message:
      "this device's key is due for replacement, and this machine replaces it with the next passkey confirmation",
  },
  'not-at-machine': {
    status: 403,
    message: 'only the owner at the machine can re-open a passkey window; run `fy passkey window <device>` there',
  },
  'unknown-device': { status: 404, message: 'no paired device has that id; `fy pair` lists none, so pair it first' },
};

const refusal = (reason: StepUpRefusal): ApiResponse => {
  const { status, message } = REFUSALS[reason];
  return errorResponse(status, message, stepUpRefusalCode(reason));
};

const caller = ({ request, credential, actor }: RouteContext): StepUpCaller => ({
  ...(request.device === undefined ? {} : { device: request.device }),
  ...(request.transcriptHash === undefined ? {} : { transcriptHash: request.transcriptHash }),
  hostLocal: arrivedOnHost(request, credential?.tokenClass === 'admin'),
  ...(actor === undefined ? {} : { actor }),
});

const answer = <T>(outcome: StepUpOutcome<T>, parse: (value: T) => unknown, status = 200): ApiResponse =>
  outcome.ok ? jsonResponse(parse(outcome.value), status) : refusal(outcome.refusal);

/**
 * What the step-up options need of the staged 2FA seeds: what a proof for one is bound to, or nothing when it is not
 * waiting. Absent: this daemon stages none, so it issues no challenge for `add-2fa-key`.
 */
export interface StagedSeedBinding {
  boundSubjectOf(stage: TwoFactorStageId): string | undefined;
}

export function stepUpRoutes(service: StepUpService, seeds?: StagedSeedBinding): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/passkeys',
      minimum: 'operator',
      noStore: true,
      // The panel that offers the first passkey must load on a machine that asks for one on opening.
      unlockExempt: true,
      handle: async context => answer(await service.view(caller(context)), value => PasskeysViewSchema.parse(value)),
    },
    {
      method: 'POST',
      path: '/v1/passkeys/options',
      minimum: 'operator',
      noStore: true,
      // Served before an unlock: a device that has just paired holds no passkey, so registering one is
      // how it gets in at all. The service's own rule (the first window, or one the owner re-opened) is
      // what bounds it, not the unlock.
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyOptionsRequestSchema);
        return answer(await service.registrationOptions(caller(context), body.origin), value =>
          PasskeyRegistrationOptionsSchema.parse(value),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/passkeys',
      minimum: 'operator',
      noStore: true,
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyRegistrationSchema);
        return answer(await service.register(caller(context), body), value => PasskeyViewSchema.parse(value), 201);
      },
    },
    {
      method: 'POST',
      path: '/v1/step-up/options',
      minimum: 'operator',
      noStore: true,
      handle: async context => {
        const body = await parseBody(context.request, StepUpOptionsRequestSchema);
        // Saving a 2FA seed binds its challenge, and so its proof, to the ONE staged save it names (its account and stage):
        // no proof stamped for the act is ever minted unbound, and only that stage's commit can spend it.
        if (body.act === STEP_UP_ACTS.addTwoFactorKey) {
          const bound = body.subject === undefined ? undefined : seeds?.boundSubjectOf(body.subject);
          if (bound === undefined)
            return errorResponse(
              404,
              'that 2FA key is not waiting to be saved: it was saved, dropped or timed out; stage it again',
              TWO_FACTOR_ERROR_CODES.stageGone,
            );
          return answer(await service.stepUpOptions(caller(context), body.origin, body.act, bound), value =>
            StepUpOptionsSchema.parse(value),
          );
        }
        return answer(await service.stepUpOptions(caller(context), body.origin, body.act), value =>
          StepUpOptionsSchema.parse(value),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/step-up',
      minimum: 'operator',
      noStore: true,
      handle: async context => {
        const body = await parseBody(context.request, StepUpAssertionSchema);
        return answer(await service.stepUp(caller(context), body), value => StepUpGrantedSchema.parse(value));
      },
    },
    // A CONFIRMATION ON OPENING (`unlockOnOpen`): the same ceremony on its own challenge, served to a
    // device the machine is otherwise refusing, so these two are the way in. Never a step-up.
    {
      method: 'POST',
      path: '/v1/unlock/options',
      minimum: 'operator',
      noStore: true,
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyOptionsRequestSchema);
        return answer(await service.unlockOptions(caller(context), body.origin), value =>
          StepUpOptionsSchema.parse(value),
        );
      },
    },
    {
      method: 'POST',
      path: '/v1/unlock',
      minimum: 'operator',
      noStore: true,
      unlockExempt: true,
      handle: async context => {
        const body = await parseBody(context.request, StepUpAssertionSchema);
        return answer(await service.unlock(caller(context), body), value => UnlockGrantedSchema.parse(value));
      },
    },
    {
      // The owner's recovery path (B4): a browser is never at the machine, so a device that missed its
      // first window or lost its authenticator would otherwise never step up again. Two layers: the
      // boundary admits only the admin token, and the service still refuses anything but the owner on
      // loopback.
      method: 'POST',
      path: '/v1/passkeys/registration-window',
      minimum: 'admin-token',
      noStore: true,
      handle: async context => {
        const body = await parseBody(context.request, PasskeyWindowRequestSchema);
        return answer(await service.reopenRegistration(caller(context), body.deviceId), value =>
          PasskeyWindowOpenedSchema.parse(value),
        );
      },
    },
  ];
}
