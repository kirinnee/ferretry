/**
 * THE PAIRING SURFACE, AND WHO MAY REACH IT.
 *
 * ## WHY THESE ROUTES ARE NOT `host`-SCOPED ANY MORE
 *
 * They were, and the effect was that nothing could pair a second device except the command line. The
 * `host` scope is refused unless the caller authenticated as `admin` (see the authorization boundary),
 * and the admin token is a file on the host — a BROWSER is always a paired device, because the only way
 * a browser gets a credential at all is by redeeming a pairing code. So the UI could not mint one from
 * the machine itself, let alone from a phone, and "add another device" had no home outside a terminal.
 *
 * They now sit at `admin` scope with a `pairing` capability demand, which is the layer that can express
 * the real rule:
 *
 * - **On loopback, no GRANT gates them.** Somebody at the machine already has the machine; they could
 *   run the pairing command or read the admin token. A grant there would be friction with no safety,
 *   and `isGovernedCaller` already says so for every capability.
 * - **Off the host, the operator's grant decides.** It is permissive by default, because adding a
 *   device from a phone is exactly what somebody away from their desk wants. What protects the machine
 *   is the one-way gate rather than the default: a caller who is not on the host may switch `pairing`
 *   OFF and can never switch it back ON. So an operator who decides that only the machine itself hands
 *   out credentials makes a decision that sticks, and a stolen phone cannot restore an access its owner
 *   has revoked.
 *
 * The honest consequence, named because a reviewer should agree to it rather than discover it: the
 * scope move widens the layer BENEATH the grant, so any paired device reaching the daemon over loopback
 * can now mint. That is the owner's stated principle for loopback, and the grant cannot narrow it — a
 * grant only ever governs a caller who is not on this host.
 *
 * ## A GOVERNED MINT NEEDS THE PASSKEY STEP-UP
 *
 * `pairing.use` is one of the uses the policy holds behind a step-up, because handing out a credential
 * is the moment access leaves this machine. A phone may add another device only after its owner has
 * confirmed with the passkey on that phone; on the host itself nothing is asked.
 *
 * ## REDEMPTION IS NOT A ROUTE ANY MORE
 *
 * A device redeeming a code has no credential yet, and the plain-HTTP `POST /v1/pair` that served it
 * handed the live code to whatever answered at an address nothing had authenticated. Redemption now
 * happens only inside a session — direct or relayed — whose daemon was proved against the QR's
 * fingerprint before the code left the device, and it registers the device's KEY rather than issuing a
 * token (`docs/pairing.md`). So nothing on this surface is public: every route here either mints a
 * code, or lists, revokes and re-grants devices.
 */

import {
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DeviceGrantsPatch,
  DeviceGrantsPatchSchema,
  type PairedDevice,
  PairedDeviceIdSchema,
  type PairedDevicesView,
  PairedDevicesViewSchema,
  type PairingCodeMintResponse,
  PairingCodeMintRequestSchema,
  PairingCodeMintResponseSchema,
  type PairingCodeStatusResponse,
  PairingCodeStatusResponseSchema,
  type PairingGrantSet,
  type PairingId,
  PairingIdSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpDemand,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import {
  ApiError,
  type ApiResponse,
  type ApiRoute,
  arrivedOnHost,
  type CapabilityDemand,
  type CapabilityPresentation,
  DEVICE_ACTOR_PREFIX,
  decodeParameter,
  errorResponse,
  jsonResponse,
  parseBody,
  parseOptionalBody,
  type RouteContext,
} from '../../api/index.ts';
import { type DeviceGrantOutcome, GrantError, isGovernedCaller } from '../../grants/index.ts';

export interface PairingSubsystem {
  /** A live code, replacing any code still outstanding, for a device that will hold `grants`. */
  mint(grants: PairingGrantSet): PairingCodeMintResponse;
  status(pairingId: PairingId): PairingCodeStatusResponse | undefined;
  /** Ends a minted code early. `undefined` when this daemon never minted that id. */
  revoke(pairingId: PairingId): PairingCodeStatusResponse | undefined;
  /** Who may reach this daemon. Never carries key material — see `PairedDeviceSchema`. */
  devices(): Promise<readonly PairedDevice[]>;
  /**
   * Takes one device's access away. False when there was no such grant.
   *
   * `actor` is who asked, server-derived, so the revocation can be audited as theirs.
   */
  revokeDevice(id: string, actor: string): Promise<boolean>;
}

/**
 * Changing one device's own grants (`docs/design/zero-trust.md` B5). `DeviceGrantService` satisfies it.
 *
 * The route demands only `pairing.use` at the boundary, because a NARROWING must stay reachable to every
 * paired device with a step-up — never harder than granting. Who may WIDEN, and the step-up every change
 * needs, are judged inside, field by field.
 */
export interface DeviceGrantSubsystem {
  mayWiden(presentation: CapabilityPresentation): CapabilityGrants;
  change(deviceId: string, patch: DeviceGrantsPatch, presentation: CapabilityPresentation): Promise<DeviceGrantOutcome>;
}

/**
 * What every governed pairing route demands.
 *
 * `use`, NOT `configure`, for all of them — including the two revocations. Minting a code and taking a
 * device's access away are both *exercising* pairing rather than changing how the host behaves, and
 * putting a revocation behind `configure` would add a gate between a person and a stolen phone at the
 * one moment it matters. Revoking must never be harder than granting.
 *
 * `pairing.configure` therefore governs no route here. It is not idle — changing a capability's grants
 * demands that capability's `configure` axis, so it is what stops a remote browser re-granting itself
 * pairing — and it is the same declared GAP `terminal`, `browser` and `filesystem` already carry. See
 * `docs/grants.md`.
 */
const PAIRING_DEMAND: CapabilityDemand = { capability: 'pairing', axis: 'use' };

/**
 * The caller's OWN device grant, when the caller is a paired device.
 *
 * Read from the server-derived actor rather than from anything the caller sent, so a browser cannot
 * claim to be a different device — and absent for the host's admin credential, which is not a paired
 * device and has no grant in this list to revoke.
 */
function callerDeviceId(actor: string | undefined): string | undefined {
  if (actor === undefined || !actor.startsWith(DEVICE_ACTOR_PREFIX)) return undefined;
  const parsed = PairedDeviceIdSchema.safeParse(actor.slice(DEVICE_ACTOR_PREFIX.length));
  return parsed.success ? parsed.data : undefined;
}

/**
 * The caller as the boundary described it. Every pairing route names a demand, so the dispatcher always
 * hands one over; its absence is a wiring mistake and refuses rather than guessing a caller.
 */
/** Whether a grant set holds every capability on both axes. */
const holdsEverything = (grants: CapabilityGrants): boolean =>
  DAEMON_CAPABILITIES.every(capability => grants[capability].use && grants[capability].configure);

function presentationIn(context: RouteContext): CapabilityPresentation {
  if (context.presentation === undefined)
    throw new ApiError(500, 'this daemon cannot say who is asking, so it is refusing', 'internal_error');
  return context.presentation;
}

async function devicesView(
  subsystem: PairingSubsystem,
  grants: DeviceGrantSubsystem,
  context: RouteContext,
): Promise<PairedDevicesView> {
  const thisDeviceId = callerDeviceId(context.actor);
  return PairedDevicesViewSchema.parse({
    devices: await subsystem.devices(),
    // The SAME answer every other host-locality rule uses, never a loopback peer on its own: a remote
    // caller forwarded through a locally bound proxy (`tailscale serve`, `cloudflared`, `ssh -L`)
    // arrives from a loopback peer too, and was told it was at this machine. Nothing derived from an
    // address, a `Host` header or the URL is consulted either: a relayed hop terminates on this host.
    hostLocal: arrivedOnHost(context.request, context.credential?.tokenClass === 'admin'),
    ...(thisDeviceId === undefined ? {} : { thisDeviceId }),
    mayWiden: grants.mayWiden(presentationIn(context)),
  });
}

/**
 * The `403 grant_step_up_required` an act that adds access answers with: the demand AND the act, so the
 * prompt the app raises names exactly what the person is confirming.
 */
function addsAccessRefusal(message: string, act: NonNullable<StepUpDemand['act']>): ApiResponse {
  return jsonResponse(
    { error: message, code: STEP_UP_REQUIRED_CODE, demand: { ...PAIRING_DEMAND, act } } satisfies StepUpRequiredBody,
    403,
  );
}

/** A device-grant refusal, as the status and code the grant surface already answers with. */
function deviceGrantRefusal(error: unknown): never {
  if (error instanceof GrantError) {
    if (error.failure === 'step-up-required') throw new ApiError(403, error.message, STEP_UP_REQUIRED_CODE);
    if (error.failure === 'unavailable') throw new ApiError(503, error.message, 'grants_undetermined');
    throw new ApiError(403, error.message, 'grant_forbidden');
  }
  throw error;
}

export function pairingRoutes(subsystem: PairingSubsystem, grants: DeviceGrantSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/pair/code',
      minimum: 'operator',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async context => {
        const body = await parseOptionalBody(context.request, PairingCodeMintRequestSchema);
        const grantSet = body?.grants ?? 'full';
        // A `full` code — the default — gives the next device every capability. A device may pass on only
        // what it holds itself, by the same rule a device widen reads (`mayWiden`), so a remote device
        // that does not hold everything mints a `limited` code or none. At the machine anything goes.
        const presentation = presentationIn(context);
        if (grantSet === 'full' && !holdsEverything(grants.mayWiden(presentation)))
          return errorResponse(
            403,
            'this device does not hold every capability, so it cannot pair a device with full access; pair it with limited access, or run `pair` at the machine',
            'grant_forbidden',
          );
        // ADDING A DEVICE ALWAYS WANTS A PASSKEY PROVED FOR IT, from any device — unlocked or not, and
        // whatever `stepUpOnActions` says. The unlock alone must never be enough to put another device on
        // this machine. At the machine nothing is asked: it already has the machine (B4).
        if (isGovernedCaller({ loopback: presentation.loopback }) && presentation.freshStepUp !== true)
          return addsAccessRefusal(
            'adding a device to this machine needs a passkey confirmation for it, from this device',
            STEP_UP_ACTS.addDevice,
          );
        const minted = subsystem.mint(grantSet);
        context.spendFreshStepUp?.();
        return jsonResponse(PairingCodeMintResponseSchema.parse(minted), 201);
      },
    },
    {
      method: 'GET',
      path: '/v1/pair/code/:pairingId',
      neverCompress: true,
      minimum: 'operator',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async ({ params }) => {
        const pairingId = PairingIdSchema.safeParse(decodeParameter(params.get('pairingId') ?? ''));
        if (!pairingId.success) return errorResponse(404, 'pairing status not found', 'pairing_status_not_found');
        const status = subsystem.status(pairingId.data);
        return status === undefined
          ? errorResponse(404, 'pairing status not found', 'pairing_status_not_found')
          : jsonResponse(PairingCodeStatusResponseSchema.parse(status));
      },
    },
    {
      /**
       * Ends a code early, addressed by pairing id.
       *
       * The ID and never the code: this value is in a URL, and a URL reaches every access log in the
       * path. A revoke keyed by the code would write the code somewhere it outlives its two minutes.
       */
      method: 'DELETE',
      path: '/v1/pair/code/:pairingId',
      minimum: 'operator',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async ({ params }) => {
        const pairingId = PairingIdSchema.safeParse(decodeParameter(params.get('pairingId') ?? ''));
        if (!pairingId.success) return errorResponse(404, 'pairing status not found', 'pairing_status_not_found');
        const status = subsystem.revoke(pairingId.data);
        return status === undefined
          ? errorResponse(404, 'pairing status not found', 'pairing_status_not_found')
          : jsonResponse(PairingCodeStatusResponseSchema.parse(status));
      },
    },
    {
      method: 'GET',
      path: '/v1/pair/devices',
      neverCompress: true,
      minimum: 'operator',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async context => jsonResponse(await devicesView(subsystem, grants, context)),
    },
    {
      /**
       * One device's access, taken away.
       *
       * It answers with the WHOLE remaining list rather than a bare 204, so a screen cannot end up
       * showing a device it has already revoked because it guessed at the new state instead of being
       * told it. A missing id is a 404 for the same reason the code revoke is: "revoked" and "there was
       * nothing here" are different answers.
       */
      method: 'DELETE',
      path: '/v1/pair/devices/:deviceId',
      minimum: 'operator',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async context => {
        const deviceId = PairedDeviceIdSchema.safeParse(decodeParameter(context.params.get('deviceId') ?? ''));
        if (!deviceId.success) return errorResponse(404, 'device not found', 'pairing_device_not_found');
        const removed = await subsystem.revokeDevice(deviceId.data, context.actor ?? 'unknown');
        return removed
          ? jsonResponse(await devicesView(subsystem, grants, context))
          : errorResponse(404, 'device not found', 'pairing_device_not_found');
      },
    },
    {
      /**
       * One device's own grants, changed (`docs/design/zero-trust.md` B5).
       *
       * `pairing.use` at the boundary, so every paired device can NARROW — its own grant included —
       * with a step-up and nothing else. Widening is judged inside, field by field: at the machine
       * anything; remotely only what the caller holds itself, with `pairing.configure` and a step-up.
       * A patch with any illegal widen is refused whole. Answers the whole list, as the revoke does.
       */
      method: 'PATCH',
      path: '/v1/pair/devices/:deviceId/grants',
      minimum: 'operator',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async context => {
        const deviceId = PairedDeviceIdSchema.safeParse(decodeParameter(context.params.get('deviceId') ?? ''));
        if (!deviceId.success) return errorResponse(404, 'device not found', 'pairing_device_not_found');
        const patch = await parseBody(context.request, DeviceGrantsPatchSchema);
        let outcome: DeviceGrantOutcome;
        try {
          outcome = await grants.change(deviceId.data, patch, presentationIn(context));
        } catch (error) {
          // A WIDEN wants a passkey proved for it alone; say which act, so the prompt can name it.
          if (error instanceof GrantError && error.failure === 'widen-step-up-required')
            return addsAccessRefusal(error.message, STEP_UP_ACTS.widenDevice);
          return deviceGrantRefusal(error);
        }
        if (outcome === 'widened') context.spendFreshStepUp?.();
        return outcome !== 'not-found'
          ? jsonResponse(await devicesView(subsystem, grants, context))
          : errorResponse(404, 'device not found', 'pairing_device_not_found');
      },
    },
  ];
}
