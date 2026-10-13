/**
 * THE PASSKEY STEP-UP SURFACE (`docs/design/zero-trust.md` B2).
 *
 * Five routes, all for a paired DEVICE and all inside a session its key opened: what this device holds,
 * the two ceremonies (register a passkey, prove one), and their options. The browser runs WebAuthn; the
 * daemon issues the challenge and verifies the answer, so a relay carrying these records can neither
 * forge an assertion nor replay one.
 *
 * NO CAPABILITY DEMAND, deliberately. These routes are how a device PROVES itself, and gating the proof
 * behind a grant would let a switched-off capability lock the owner out of the very ceremony that
 * re-opens it. What they hand out is bounded instead: a step-up is fifteen minutes for one running copy
 * of the app, it widens nothing a grant refused, and adding a passkey has its own rule (see
 * `StepUpService`).
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
  StepUpAssertionSchema,
  StepUpGrantedSchema,
  StepUpOptionsSchema,
  type StepUpRefusal,
  stepUpRefusalCode,
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
      'a new passkey can only be added within ten minutes of pairing, from a device that has just confirmed with a passkey, or at the machine itself',
  },
  'too-many-passkeys': { status: 409, message: 'this device already holds as many passkeys as it may' },
  'no-passkey': { status: 404, message: 'this copy of the app has no passkey for this machine' },
  'not-verified': { status: 401, message: 'that passkey confirmation did not check out; try again' },
};

const refusal = (reason: StepUpRefusal): ApiResponse => {
  const { status, message } = REFUSALS[reason];
  return errorResponse(status, message, stepUpRefusalCode(reason));
};

const caller = ({ request, credential }: RouteContext): StepUpCaller => ({
  ...(request.device === undefined ? {} : { device: request.device }),
  hostLocal: arrivedOnHost(request, credential?.tokenClass === 'admin'),
});

const answer = <T>(outcome: StepUpOutcome<T>, parse: (value: T) => unknown, status = 200): ApiResponse =>
  outcome.ok ? jsonResponse(parse(outcome.value), status) : refusal(outcome.refusal);

export function stepUpRoutes(service: StepUpService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/passkeys',
      minimum: 'operator',
      noStore: true,
      handle: async context => answer(await service.view(caller(context)), value => PasskeysViewSchema.parse(value)),
    },
    {
      method: 'POST',
      path: '/v1/passkeys/options',
      minimum: 'operator',
      noStore: true,
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
        const body = await parseBody(context.request, PasskeyOptionsRequestSchema);
        return answer(await service.stepUpOptions(caller(context), body.origin), value =>
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
  ];
}
