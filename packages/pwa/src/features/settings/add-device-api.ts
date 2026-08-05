/**
 * The browser's half of the pairing routes.
 *
 * Every call takes a client rather than building one, and nothing here is cached at module scope. A
 * pairing code and a device list belong to ONE MACHINE, and one browser can be paired to several, so a
 * code minted for daemon A must never be shown under daemon B — the same rule the grant and secret
 * surfaces are written to, for the same reason.
 *
 * ## THE CODE IS RETURNED AND THEN FORGOTTEN
 *
 * `mintPairingCode` hands its answer straight back to the caller. There is no field for it here, no
 * memo, and no storage of any kind, so there is nowhere for a live credential to outlive the call that
 * produced it. Nothing in this module logs, and that is deliberate: a `console.debug` of a response on
 * this route would put a working pairing code in the browser's console for anybody who opens it later.
 *
 * ## REVOCATION IS ADDRESSED BY ID, NEVER BY CODE
 *
 * A pairing id is a non-secret handle the mint answers with precisely so a revoke can be a URL. The code
 * itself never enters a path or a query, because a URL reaches every access log in the path and a code in
 * a log outlives its two minutes.
 */

import {
  type IFyApiClient,
  type PairedDevicesView,
  PairedDevicesViewSchema,
  type PairingCodeMintResponse,
  PairingCodeMintResponseSchema,
  type PairingCodeStatusResponse,
  PairingCodeStatusResponseSchema,
  type PairingId,
} from '@ferretry/protocol';

/** The only client capability this surface uses. */
export type PairingClient = Pick<IFyApiClient, 'request'>;

export const PAIRING_CODE_PATH = '/v1/pair/code';
export const PAIRED_DEVICES_PATH = '/v1/pair/devices';

/**
 * Mints a code for this daemon.
 *
 * BODYLESS BY CONTRACT: the redeeming device names ITSELF, so there is nothing for this end to send. The
 * request schema is strict, so inventing a field here would be refused rather than quietly ignored.
 */
export async function mintPairingCode(client: PairingClient): Promise<PairingCodeMintResponse> {
  return await client.request(PAIRING_CODE_PATH, PairingCodeMintResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Ends a minted code before its window closes. Answers with the code's fate, never with the code. */
export async function revokePairingCode(
  client: PairingClient,
  pairingId: PairingId,
): Promise<PairingCodeStatusResponse> {
  return await client.request(
    `${PAIRING_CODE_PATH}/${encodeURIComponent(pairingId)}`,
    PairingCodeStatusResponseSchema,
    {
      method: 'DELETE',
    },
  );
}

/**
 * Reads who may reach this daemon, and the two facts the panel needs before it offers anything.
 *
 * ONE READ, NOT A PROBE PER CONTROL. The view carries whether this request arrived on the host and which
 * grant is the caller's own, so the panel can explain itself before somebody presses a button — which is
 * the entire requirement. A UI that discovers its limits by watching calls fail has nothing to say until
 * after the click.
 */
export async function readPairedDevices(client: PairingClient): Promise<PairedDevicesView> {
  return await client.request(PAIRED_DEVICES_PATH, PairedDevicesViewSchema);
}

/**
 * Takes one device's access away and answers with the remaining list.
 *
 * The daemon returns the whole list rather than a bare acknowledgement, so a screen never has to guess
 * at the new state — guessing is how a revoked device stays on screen, or a surviving one vanishes.
 */
export async function revokePairedDevice(client: PairingClient, deviceId: string): Promise<PairedDevicesView> {
  return await client.request(`${PAIRED_DEVICES_PATH}/${encodeURIComponent(deviceId)}`, PairedDevicesViewSchema, {
    method: 'DELETE',
  });
}

/** A failure, as the two things a screen has to tell apart: what to say, and whether it was a decision. */
export interface PairingFailure {
  readonly message: string;
  /** The daemon's error code when it gave one — `grant_*` for the operator's decision. */
  readonly code?: string;
}

/**
 * Reads a thrown failure without assuming which layer threw it.
 *
 * The client's own error type carries a `code`; a transport failure and a schema failure carry only a
 * message. Both reach this surface, and the code is read STRUCTURALLY rather than by instance check so a
 * transport wrapper that preserves the field is not silently downgraded to "unknown error".
 */
export function pairingFailure(cause: unknown): PairingFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' ? { message, code } : { message };
}
