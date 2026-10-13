/**
 * The browser's half of a credential's sign-in (docs/design/account-model.md §4.6).
 *
 * NOTHING HERE HOLDS A CREDENTIAL. Two values come out — a verification URL, and for Codex a device
 * code — and exactly one goes in: a short-lived authorization code, in a request body, forwarded to the
 * harness child's stdin on the host and retained nowhere. There is no shape in this module that could
 * carry a provider token in either direction, because there is no field for one in the shared contract
 * these calls parse through.
 *
 * EVERY WIRE SHAPE IS THE SHARED ONE, from `@ferretry/protocol`, which the daemon parses its own answers
 * through on the way out. So this browser and that daemon cannot hold two different ideas of what a
 * sign-in is, and a value this browser would send that the daemon would refuse fails here — at the call —
 * rather than as a 400 a person reads as a broken panel.
 *
 * Every call takes a connection-bound client and an optional unlock. A fleet belongs to a MACHINE and
 * this browser can be paired to several, so nothing is cached at module scope; the unlock is per daemon
 * for the same reason.
 */

import {
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  type HarnessLoginStartRequest,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
  OPERATOR_UNLOCK_HEADER,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-client.ts';

export const FLEET_LOGIN_PATH = '/v1/fleet/login';

/** Headers for a governed caller that holds an unlock, and nothing extra for one that does not. */
const unlockHeaders = (unlock: string | undefined): Record<string, string> =>
  unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock };

const flowPath = (flowId: string): string => `${FLEET_LOGIN_PATH}/${encodeURIComponent(flowId)}`;

/** A credential sign-in, as the daemon reports it. */
export type CredentialLoginFlow = HarnessLoginFlow;

/** Starting a sign-in from a credential, which every runtime on it then reads (E31). */
export type CredentialLoginStartRequest = HarnessLoginStartRequest;

/**
 * Starts signing one CREDENTIAL in: every runtime on it, or none yet — an empty slot is signed in
 * before anything uses it (E12, E31).
 *
 * TWO DIFFERENT USES OF ONE SECRET. `unlock` is the token a mint produced and it travels in the header
 * the dispatcher reads for every governed route, so a locked caller stops being locked.
 * `operatorPassword` is the per-change confirmation and is the PASSWORD ITSELF, proved again against
 * this one sign-in. Neither is persisted or echoed anywhere.
 */
export const startCredentialSignIn = async (
  client: FleetClient,
  request: CredentialLoginStartRequest,
  unlock?: string,
): Promise<CredentialLoginFlow> =>
  await client.request(FLEET_LOGIN_PATH, HarnessLoginFlowSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...unlockHeaders(unlock) },
      body: JSON.stringify(HarnessLoginStartRequestSchema.parse(request)),
    });

/** Re-reads one live credential sign-in. Polled, because the person is acting somewhere this browser cannot see. */
export const readCredentialSignIn = async (
  client: FleetClient,
  flowId: string,
  unlock?: string,
): Promise<CredentialLoginFlow> =>
  await client.request(flowPath(flowId), HarnessLoginFlowSchema, { headers: unlockHeaders(unlock) });

/** Ends one credential sign-in and the harness child behind it. */
export const cancelCredentialSignIn = async (
  client: FleetClient,
  flowId: string,
  unlock?: string,
): Promise<CredentialLoginFlow> =>
  await client.request(flowPath(flowId), HarnessLoginFlowSchema, {
      method: 'DELETE',
      headers: unlockHeaders(unlock),
    });

/**
 * Forwards the one value a person brings back.
 *
 * WRITE-ONLY AND SINGLE-USE. It travels in a BODY because a query parameter reaches every proxy's access
 * log, and the caller is expected to clear it from its own state before this promise settles: an
 * authorization code must not sit in a rendered tree, a retry affordance, or a screenshot.
 */
export const submitCredentialSignInCode = async (
  client: FleetClient,
  flowId: string,
  code: string,
  unlock?: string,
): Promise<HarnessLoginSubmission> =>
  await client.request(flowPath(flowId), HarnessLoginSubmissionSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...unlockHeaders(unlock) },
    body: JSON.stringify(HarnessLoginSubmitRequestSchema.parse({ code })),
  });
