/**
 * The app's half of a login's sign-in (docs/design/harness-login.md).
 *
 * NOTHING HERE HOLDS A CREDENTIAL. Two values come out — a verification URL, and for a Codex device grant its user
 * code — and exactly one goes in: a short-lived authorization code (Claude's, or the address a Codex link sign-in
 * ended on), in a request body, forwarded to the harness child on the host and retained nowhere. There is no shape
 * here that could carry a provider token in either direction, because there is no field for one in the contract
 * these calls parse through.
 *
 * Every call takes the per-daemon client; nothing is cached at module scope.
 */

import {
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  type HarnessLoginStartRequest,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
} from '../../contract/index.ts';
import type { LoginsClient } from './client.ts';

export const SIGN_IN_ROUTES = {
  start: 'POST /v1/logins/sign-in',
  read: 'GET /v1/logins/sign-in/:flowId',
  submit: 'POST /v1/logins/sign-in/:flowId',
  cancel: 'DELETE /v1/logins/sign-in/:flowId',
} as const;

/** A login's sign-in, as the daemon reports it. */
export type LoginSignInFlow = HarnessLoginFlow;

/** Starting a sign-in from a login, which every runtime on it then reads. */
export type LoginSignInStartRequest = HarnessLoginStartRequest;

const postStart = async (client: LoginsClient, request: LoginSignInStartRequest): Promise<LoginSignInFlow> =>
  HarnessLoginFlowSchema.parse(
    await client.call(SIGN_IN_ROUTES.start, { body: HarnessLoginStartRequestSchema.parse(request) }),
  );

/**
 * Starts signing one LOGIN in: every runtime on it, or none yet — an empty slot is signed in before anything uses it.
 * A sign-in already running for it is PICKED UP (`resumed`), never an error: the daemon answers with it.
 */
export const startLoginSignIn = async (
  client: LoginsClient,
  request: LoginSignInStartRequest,
): Promise<LoginSignInFlow> => await postStart(client, request);

/**
 * Starts one login's sign-in OVER: the running one ends — its child killed and waited for — any leftover Codex
 * sign-in is cleared off the callback port, and a fresh one starts.
 */
export const restartLoginSignIn = async (
  client: LoginsClient,
  request: LoginSignInStartRequest,
  running: string | undefined,
): Promise<LoginSignInFlow> => {
  if (running !== undefined) await cancelLoginSignIn(client, running).catch(() => undefined);
  return await postStart(client, { ...request, restart: true });
};

/** Re-reads one live sign-in. Polled, because the person is acting somewhere this browser cannot see. */
export const readLoginSignIn = async (client: LoginsClient, flowId: string): Promise<LoginSignInFlow> =>
  HarnessLoginFlowSchema.parse(await client.call(SIGN_IN_ROUTES.read, { params: { flowId } }));

/** Ends one sign-in and the harness child behind it. */
export const cancelLoginSignIn = async (client: LoginsClient, flowId: string): Promise<LoginSignInFlow> =>
  HarnessLoginFlowSchema.parse(await client.call(SIGN_IN_ROUTES.cancel, { params: { flowId } }));

const submit = async (client: LoginsClient, flowId: string, body: unknown): Promise<HarnessLoginSubmission> =>
  HarnessLoginSubmissionSchema.parse(
    await client.call(SIGN_IN_ROUTES.submit, {
      params: { flowId },
      body: HarnessLoginSubmitRequestSchema.parse(body),
    }),
  );

/**
 * Forwards the one value a person brings back.
 *
 * WRITE-ONLY AND SINGLE-USE. It travels in a BODY, never a query, and the caller clears it from its own state before
 * this promise settles: an authorization code must not sit in a rendered tree, a retry affordance, or a screenshot.
 */
export const submitLoginSignInCode = async (
  client: LoginsClient,
  flowId: string,
  code: string,
): Promise<HarnessLoginSubmission> => await submit(client, flowId, { code });

/** Moves a Codex device-code sign-in that did not work to Codex's link sign-in, in the same flow. */
export const switchLoginSignInToLink = async (client: LoginsClient, flowId: string): Promise<HarnessLoginSubmission> =>
  await submit(client, flowId, { method: 'link' });

/**
 * Looks in the login's store again, for a sign-in that ended `recheck`: the harness finished, but its login was not
 * found. Launches nothing on the host — a login that landed late completes the flow; one still missing answers
 * `refused` with what was found.
 */
export const recheckLoginSignIn = async (client: LoginsClient, flowId: string): Promise<HarnessLoginSubmission> =>
  await submit(client, flowId, { method: 'recheck' });
