/**
 * The browser's half of a credential's sign-in (docs/design/account-model.md §4.6).
 *
 * NOTHING HERE HOLDS A CREDENTIAL. Two values come out — a verification URL, and for a Codex device
 * grant its user code — and exactly one goes in: a short-lived authorization code (Claude's, or the
 * address a Codex link sign-in ended on), in a request body, forwarded to the harness child on the host
 * and retained nowhere. There is no shape in this module that could carry a provider token in either
 * direction, because there is no field for one in the shared contract these calls parse through.
 *
 * EVERY WIRE SHAPE IS THE SHARED ONE, from `@ferretry/protocol`, which the daemon parses its own answers
 * through on the way out. So this browser and that daemon cannot hold two different ideas of what a
 * sign-in is, and a value this browser would send that the daemon would refuse fails here — at the call —
 * rather than as a 400 a person reads as a broken panel.
 *
 * Every call takes a connection-bound client. A fleet belongs to a MACHINE and
 * this browser can be paired to several, so nothing is cached at module scope.
 */

import {
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  type HarnessLoginStartRequest,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetClient } from './fleet-client.ts';

export const FLEET_LOGIN_PATH = '/v1/fleet/login';

const flowPath = (flowId: string): string => `${FLEET_LOGIN_PATH}/${encodeURIComponent(flowId)}`;

/** A credential sign-in, as the daemon reports it. */
export type CredentialLoginFlow = HarnessLoginFlow;

/** Starting a sign-in from a credential, which every runtime on it then reads (E31). */
export type CredentialLoginStartRequest = HarnessLoginStartRequest;

const postStart = async (client: FleetClient, request: CredentialLoginStartRequest): Promise<CredentialLoginFlow> =>
  await client.request(FLEET_LOGIN_PATH, HarnessLoginFlowSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(HarnessLoginStartRequestSchema.parse(request)),
  });

/**
 * How a daemon released before sign-ins were picked up refused a second start: in prose, naming the
 * running flow. The id is read out of it only to open that flow — it is never shown.
 */
const LEGACY_IN_PROGRESS = /already running as flow "([^"]+)"/u;

/**
 * Starts signing one CREDENTIAL in: every runtime on it, or none yet — an empty slot is signed in
 * before anything uses it (E12, E31).
 *
 * A sign-in already running for it is PICKED UP (`resumed`), never an error: the daemon answers with
 * it, and a daemon too old to do that is asked for the flow its refusal named, so this browser lands on
 * the same link and code whichever daemon it is talking to.
 */
export const startCredentialSignIn = async (
  client: FleetClient,
  request: CredentialLoginStartRequest,
): Promise<CredentialLoginFlow> => {
  try {
    return await postStart(client, request);
  } catch (error) {
    const running =
      error instanceof FyHttpError && error.code === 'fleet_login_in_progress'
        ? LEGACY_IN_PROGRESS.exec(error.message)?.[1]
        : undefined;
    if (running === undefined) throw error;
    return { ...(await readCredentialSignIn(client, running)), resumed: true };
  }
};

/**
 * Starts one credential's sign-in OVER: the running one ends — its child killed and waited for — any
 * leftover Codex sign-in is cleared off the callback port, and a fresh one starts.
 *
 * The running flow is cancelled first because a daemon too old to know `restart` needs exactly that,
 * and refuses the field itself as a malformed body; it is then asked for an ordinary start.
 */
export const restartCredentialSignIn = async (
  client: FleetClient,
  request: CredentialLoginStartRequest,
  running: string | undefined,
): Promise<CredentialLoginFlow> => {
  if (running !== undefined) await cancelCredentialSignIn(client, running).catch(() => undefined);
  try {
    return await postStart(client, { ...request, restart: true });
  } catch (error) {
    if (error instanceof FyHttpError && error.status === 400) return await startCredentialSignIn(client, request);
    throw error;
  }
};

/** Re-reads one live credential sign-in. Polled, because the person is acting somewhere this browser cannot see. */
export const readCredentialSignIn = async (client: FleetClient, flowId: string): Promise<CredentialLoginFlow> =>
  await client.request(flowPath(flowId), HarnessLoginFlowSchema);

/** Ends one credential sign-in and the harness child behind it. */
export const cancelCredentialSignIn = async (client: FleetClient, flowId: string): Promise<CredentialLoginFlow> =>
  await client.request(flowPath(flowId), HarnessLoginFlowSchema, { method: 'DELETE' });

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
): Promise<HarnessLoginSubmission> =>
  await client.request(flowPath(flowId), HarnessLoginSubmissionSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(HarnessLoginSubmitRequestSchema.parse({ code })),
  });

/**
 * Moves a Codex device-code sign-in that did not work to Codex's link sign-in, in the same flow.
 */
export const switchCredentialSignInToLink = async (
  client: FleetClient,
  flowId: string,
): Promise<HarnessLoginSubmission> =>
  await client.request(flowPath(flowId), HarnessLoginSubmissionSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(HarnessLoginSubmitRequestSchema.parse({ method: 'link' })),
  });

/**
 * Looks in the credential's store again, for a sign-in that ended `recheck`: the harness finished, but
 * its login was not found. Launches nothing on the host and sends nothing but the request itself — a
 * login that landed late completes the flow; one still missing answers `refused` with what was found.
 */
export const recheckCredentialSignIn = async (client: FleetClient, flowId: string): Promise<HarnessLoginSubmission> =>
  await client.request(flowPath(flowId), HarnessLoginSubmissionSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(HarnessLoginSubmitRequestSchema.parse({ method: 'recheck' })),
  });
