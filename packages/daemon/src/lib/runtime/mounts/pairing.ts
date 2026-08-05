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
 * - **On loopback, nothing gates them.** Somebody at the machine already has the machine; they could
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
 * ## REDEMPTION STAYS PUBLIC, AND STAYS THE ONLY PUBLIC ROUTE HERE
 *
 * A device redeeming a code has no credential yet — that is the whole point of the exchange — so
 * `POST /v1/pair` is `public` and the CODE is the credential for that one request. Everything else on
 * this surface either mints a credential or lists and revokes them, and none of it is public.
 */

import {
  type PairedDevice,
  PairedDeviceIdSchema,
  type PairedDevicesView,
  PairedDevicesViewSchema,
  PairingCodeMintRequestSchema,
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  type PairingCodeStatusResponse,
  PairingCodeStatusResponseSchema,
  type PairingId,
  PairingIdSchema,
  PairingResponseSchema,
} from '@ferretry/protocol';
import {
  type ApiRequest,
  type ApiRoute,
  type CapabilityDemand,
  decodeParameter,
  DEVICE_ACTOR_PREFIX,
  errorResponse,
  jsonResponse,
  parseOptionalBody,
} from '../../api/index.ts';
import type { PairingRedemption } from '../../pairing/index.ts';

export interface PairingSubsystem {
  mint(): PairingCodeMintResponse;
  status(pairingId: PairingId): PairingCodeStatusResponse | undefined;
  /** Ends a minted code early. `undefined` when this daemon never minted that id. */
  revoke(pairingId: PairingId): PairingCodeStatusResponse | undefined;
  /** Who may reach this daemon. Never carries a token digest — see `PairedDeviceSchema`. */
  devices(): Promise<readonly PairedDevice[]>;
  /** Takes one device's access away. False when there was no such grant. */
  revokeDevice(id: string): Promise<boolean>;
  redeem(value: unknown, rateLimitKey: string): Promise<PairingRedemption>;
}

const refused = () => errorResponse(403, 'pairing refused', 'pairing_refused');

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

async function pairingBody(request: ApiRequest): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    // Syntax, shape and body-read failures deliberately collapse into the same public refusal as a
    // wrong code. The service still performs its constant-time comparison without letting broken
    // uploads spend the daemon-wide code-guess budget.
    return undefined;
  }
}

function rateLimitKey(request: ApiRequest): string {
  return request.clientAddress ?? (request.loopback ? 'loopback-unknown' : 'remote-unknown');
}

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

async function devicesView(
  subsystem: PairingSubsystem,
  request: ApiRequest,
  actor: string | undefined,
): Promise<PairedDevicesView> {
  const thisDeviceId = callerDeviceId(actor);
  return PairedDevicesViewSchema.parse({
    devices: await subsystem.devices(),
    // The TRANSPORT's answer and nothing else. A relayed hop terminates on this very host, so anything
    // derived from an address, a `Host` header or the URL would tell a remote phone it is local.
    hostLocal: request.loopback,
    ...(thisDeviceId === undefined ? {} : { thisDeviceId }),
  });
}

export function pairingRoutes(subsystem: PairingSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/pair',
      scope: 'public',
      noStore: true,
      handle: async ({ request }) => {
        const result = await subsystem.redeem(await pairingBody(request), rateLimitKey(request));
        return result.kind === 'paired' ? jsonResponse(PairingResponseSchema.parse(result.response)) : refused();
      },
    },
    {
      method: 'POST',
      path: '/v1/pair/code',
      scope: 'admin',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async ({ request }) => {
        await parseOptionalBody(request, PairingCodeMintRequestSchema);
        return jsonResponse(PairingCodeMintResponseSchema.parse(subsystem.mint()), 201);
      },
    },
    {
      method: 'GET',
      path: '/v1/pair/code/:pairingId',
      scope: 'admin',
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
      scope: 'admin',
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
      scope: 'admin',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async ({ request, actor }) => jsonResponse(await devicesView(subsystem, request, actor)),
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
      scope: 'admin',
      capability: PAIRING_DEMAND,
      noStore: true,
      handle: async ({ request, params, actor }) => {
        const deviceId = PairedDeviceIdSchema.safeParse(decodeParameter(params.get('deviceId') ?? ''));
        if (!deviceId.success) return errorResponse(404, 'device not found', 'pairing_device_not_found');
        const removed = await subsystem.revokeDevice(deviceId.data);
        return removed
          ? jsonResponse(await devicesView(subsystem, request, actor))
          : errorResponse(404, 'device not found', 'pairing_device_not_found');
      },
    },
  ];
}
