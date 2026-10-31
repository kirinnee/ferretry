/**
 * THE WEB PUSH SURFACE, AND WHO MAY REACH IT.
 *
 * ## A DEVICE ENROLLING ITSELF NEEDS NOTHING BUT BEING PAIRED
 *
 * Self-enrolment grants nothing: it lets this daemon reach the device that asked, and only that one. So a
 * paired device may read the key, enrol, list and un-enrol ITS OWN enrolments with no capability demand
 * and no step-up (`docs/design/zero-trust.md` B5) — a default device, which holds `fleet.use` only, still
 * gets alerts. Requiring `pairing.use` here, which needs a step-up, made notifications cost a passkey touch
 * and made a least-privilege device unable to receive them at all.
 *
 * ## ANOTHER DEVICE'S ENROLMENT IS DEVICE MANAGEMENT
 *
 * Seeing every device's enrolments, or revoking one a different device filed, is managing devices, so it
 * is decided by `pairing.use` — asked of the boundary's own decision for this caller, never re-derived
 * here. Only the owner at the machine (the admin token over loopback) is ungoverned and sees everything;
 * a browser on the host is a governed device like any other (B4).
 *
 * `use`, never `configure`: revoking must never be harder than granting.
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
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
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
  type CapabilityGuard,
  grantRefusalCode,
  type RouteContext,
} from '../../api/index.ts';
import { PushError } from '../../push/index.ts';

export interface PushSubscriptionSubsystem {
  /** This daemon's application-server public key. Never the private half — see `src/lib/push`. */
  publicKey(): Promise<string>;
  list(): Promise<readonly PushDeviceView[]>;
  /** One device's own enrolments. */
  listFor(deviceId: string): Promise<readonly PushDeviceView[]>;
  /** Which device filed an enrolment, or nothing for an id that is not enrolled. */
  ownerOf(id: string): Promise<string | undefined>;
  register(deviceId: string, request: RegisterPushDeviceRequest): Promise<PushDeviceView>;
  revoke(id: string): Promise<PushDeviceView>;
}

/** What managing ANOTHER device's enrolment demands. A device's own needs none — see the header. */
const MANAGE_DEMAND: CapabilityDemand = { capability: 'pairing', axis: 'use' };
/** What a self-enrolment step-up names on the prompt: managing this device, not granting anything. */
const ENROL_DEMAND = { capability: 'pairing', axis: 'use' } as const;

/**
 * Whether this caller may manage every device's enrolments, asked of the grant layer's own decision.
 *
 * The presentation is the boundary's — the dispatcher assembles it for every authenticated route — and
 * the guard is the same one every governed route is decided by, so nothing here re-derives locality.
 * Absent is refused: a caller nobody described manages nothing.
 */
function managesDevices(context: RouteContext, guard: CapabilityGuard): boolean {
  if (context.presentation === undefined) return false;
  return guard.decide(MANAGE_DEMAND, context.presentation).allowed;
}

/** The sentence and code a refused cross-device act gets — the same envelope the boundary would send. */
function manageRefusal(context: RouteContext, guard: CapabilityGuard): ApiResponse {
  const refusal =
    context.presentation === undefined ? 'undetermined' : guard.decide(MANAGE_DEMAND, context.presentation).refusal;
  return errorResponse(
    403,
    guard.explain(MANAGE_DEMAND, refusal) ??
      'only a device that may manage devices can change another device’s notifications',
    grantRefusalCode(refusal),
  );
}

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

export function pushRoutes(subsystem: PushSubscriptionSubsystem, guard: CapabilityGuard): readonly ApiRoute[] {
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
      handle: async () => jsonResponse(VapidPublicKeyResponseSchema.parse({ publicKey: await subsystem.publicKey() })),
    },
    {
      /** Every device's enrolments for a caller that may manage devices; otherwise the caller's own. */
      method: 'GET',
      path: '/v1/push/subscriptions',
      neverCompress: true,
      minimum: 'operator',
      noStore: true,
      handle: async context => {
        try {
          if (managesDevices(context, guard))
            return jsonResponse(PushDeviceListResponseSchema.parse({ devices: await subsystem.list() }));
          // Not a manager: a device sees its own; a caller that is no device has no "own", and is refused.
          const own = callerDeviceId(context.actor);
          if (own === undefined) return manageRefusal(context, guard);
          return jsonResponse(PushDeviceListResponseSchema.parse({ devices: await subsystem.listFor(own) }));
        } catch (error) {
          return pushFailure(error);
        }
      },
    },
    {
      method: 'POST',
      path: '/v1/push/subscriptions',
      minimum: 'operator',
      noStore: true,
      handle: async ({ request, actor, presentation }) => {
        const deviceId = callerDeviceId(actor);
        if (deviceId === undefined)
          return errorResponse(403, 'only a paired device can enrol for notifications', 'push_device_required');
        // No capability — a default device still gets its alerts — but a governed device confirms with a
        // passkey: enrolling sends requests from this host to the endpoint, now and on every alert.
        if (presentation !== undefined && !presentation.loopback && !presentation.stepUp)
          return jsonResponse(
            {
              error: 'enrolling this device for notifications needs a passkey confirmation from it',
              code: STEP_UP_REQUIRED_CODE,
              demand: ENROL_DEMAND,
            } satisfies StepUpRequiredBody,
            403,
          );
        const body = await parseBody(request, RegisterPushDeviceRequestSchema);
        try {
          return jsonResponse(PushDeviceViewSchema.parse(await subsystem.register(deviceId, body)), 201);
        } catch (error) {
          return pushFailure(error);
        }
      },
    },
    {
      /** A device's own enrolment, freely; another device's, only for a caller that may manage devices. */
      method: 'DELETE',
      path: '/v1/push/subscriptions/:pushId',
      minimum: 'operator',
      noStore: true,
      handle: async context => {
        const pushId = PushDeviceViewSchema.shape.id.safeParse(decodeParameter(context.params.get('pushId') ?? ''));
        if (!pushId.success) return errorResponse(404, 'no push enrolment with that id', 'push_not_found');
        try {
          const owner = await subsystem.ownerOf(pushId.data);
          if (owner === undefined) return errorResponse(404, 'no push enrolment with that id', 'push_not_found');
          if (owner !== callerDeviceId(context.actor) && !managesDevices(context, guard))
            return manageRefusal(context, guard);
          return jsonResponse(PushDeviceViewSchema.parse(await subsystem.revoke(pushId.data)));
        } catch (error) {
          return pushFailure(error);
        }
      },
    },
  ];
}
