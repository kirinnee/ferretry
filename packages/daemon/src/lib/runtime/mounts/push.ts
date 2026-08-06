/**
 * THE WEB PUSH SURFACE, AND WHO MAY REACH IT.
 *
 * ## IT IS GOVERNED BY `pairing`, AND THAT IS A DECISION RATHER THAN A SHORTCUT
 *
 * A seventh capability was the obvious move and it is the wrong one. What these routes do is manage a
 * PAIRED DEVICE's relationship with this machine: only a paired device can enrol, an enrolment is
 * recorded against that device's grant, and revoking the grant destroys the enrolment. Enrolling is
 * the reverse direction of the same relationship pairing establishes — "who may reach this daemon" and
 * "who this daemon may reach" — so the operator's single decision about device management governs
 * both, and the one-way gate they already have means switching `pairing` off from a phone stops that
 * phone both from handing out credentials and from signing new devices up for notifications.
 *
 * `docs/grants.md` says the capability list is closed on purpose: a grant list that grew to cover every
 * route would be a second copy of the route table. The honest consequence of reusing `pairing` is
 * named there rather than left to be discovered — an operator who turns `pairing` off remotely also
 * turns off remote enrolment and remote un-enrolment, which is coherent (both are device management)
 * but is not the same thing as a switch labelled "notifications".
 *
 * `use`, never `configure`, for all four — including the revocation, for the reason the pairing mount
 * gives: revoking must never be harder than granting.
 *
 * ## ONLY A DEVICE MAY ENROL
 *
 * The owning device id comes from the actor the authorization boundary derived, never from the body,
 * so a browser cannot file an enrolment against a device it does not hold. The host's admin token is
 * refused: it is not a paired device, it has no browser and no push endpoint, and an enrolment filed
 * against nothing would be a row that can never be revoked with a device — the exact orphan the
 * lifetime rule exists to prevent.
 */

import {
  PairedDeviceIdSchema,
  PushDeviceListResponseSchema,
  PushDeviceViewSchema,
  RegisterPushDeviceRequestSchema,
  VapidPublicKeyResponseSchema,
  type PushDeviceView,
  type RegisterPushDeviceRequest,
} from '@ferretry/protocol';
import {
  decodeParameter,
  DEVICE_ACTOR_PREFIX,
  errorResponse,
  jsonResponse,
  parseBody,
  type ApiResponse,
  type ApiRoute,
  type CapabilityDemand,
} from '../../api/index.ts';
import { PushError } from '../../push/index.ts';

export interface PushSubscriptionSubsystem {
  /** This daemon's application-server public key. Never the private half — see `src/lib/push`. */
  publicKey(): Promise<string>;
  list(): Promise<readonly PushDeviceView[]>;
  register(deviceId: string, request: RegisterPushDeviceRequest): Promise<PushDeviceView>;
  revoke(id: string): Promise<PushDeviceView>;
}

/** What every push route demands. See this file's header for why it is `pairing` and not a seventh. */
const PUSH_DEMAND: CapabilityDemand = { capability: 'pairing', axis: 'use' };

/**
 * The HTTP answer for each refusal the domain raises.
 *
 * `corrupt_store` is a 503 rather than a 500 because it is a state this daemon can recover from once
 * somebody repairs or removes the document, and a client that can tell "damaged, retry later" from
 * "defect" can say something useful instead of "unknown error".
 */
function pushFailure(error: unknown): ApiResponse {
  if (!(error instanceof PushError)) throw error;
  if (error.code === 'not_found') return errorResponse(404, error.message, 'push_not_found');
  if (error.code === 'corrupt_store') return errorResponse(503, error.message, 'push_corrupt_store');
  return errorResponse(400, error.message, 'push_invalid');
}

/**
 * The caller's OWN device grant, or nothing when the caller is not a paired device.
 *
 * Read from the server-derived actor exactly as the pairing mount reads it, so the enrolment's owner
 * is the credential that made the request rather than a claim in a body.
 */
function callerDeviceId(actor: string | undefined): string | undefined {
  if (actor === undefined || !actor.startsWith(DEVICE_ACTOR_PREFIX)) return undefined;
  const parsed = PairedDeviceIdSchema.safeParse(actor.slice(DEVICE_ACTOR_PREFIX.length));
  return parsed.success ? parsed.data : undefined;
}

export function pushRoutes(subsystem: PushSubscriptionSubsystem): readonly ApiRoute[] {
  return [
    {
      /**
       * The application-server key a browser subscribes with.
       *
       * NOT `noStore`, unlike everything else here. It is one stable public point per daemon, it is
       * not a credential, and a browser re-reads it on every enrolment attempt — so a cached copy is
       * the correct answer rather than a stale one.
       */
      method: 'GET',
      path: '/v1/push/vapid',
      minimum: 'operator',
      capability: PUSH_DEMAND,
      handle: async () => jsonResponse(VapidPublicKeyResponseSchema.parse({ publicKey: await subsystem.publicKey() })),
    },
    {
      method: 'GET',
      path: '/v1/push/subscriptions',
      minimum: 'operator',
      capability: PUSH_DEMAND,
      noStore: true,
      handle: async () => {
        try {
          return jsonResponse(PushDeviceListResponseSchema.parse({ devices: await subsystem.list() }));
        } catch (error) {
          return pushFailure(error);
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/push/subscriptions',
      minimum: 'operator',
      capability: PUSH_DEMAND,
      noStore: true,
      handle: async ({ request, actor }) => {
        const deviceId = callerDeviceId(actor);
        if (deviceId === undefined)
          return errorResponse(403, 'only a paired device can enrol for notifications', 'push_device_required');
        const body = await parseBody(request, RegisterPushDeviceRequestSchema);
        try {
          return jsonResponse(PushDeviceViewSchema.parse(await subsystem.register(deviceId, body)), 201);
        } catch (error) {
          return pushFailure(error);
        }
      },
    },
    {
      method: 'DELETE',
      path: '/v1/push/subscriptions/:pushId',
      minimum: 'operator',
      capability: PUSH_DEMAND,
      noStore: true,
      handle: async ({ params }) => {
        const pushId = PushDeviceViewSchema.shape.id.safeParse(decodeParameter(params.get('pushId') ?? ''));
        if (!pushId.success) return errorResponse(404, 'no push enrolment with that id', 'push_not_found');
        try {
          return jsonResponse(PushDeviceViewSchema.parse(await subsystem.revoke(pushId.data)));
        } catch (error) {
          return pushFailure(error);
        }
      },
    },
  ];
}
