/**
 * The browser's half of the harness-login boundary.
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
  type FleetLoginReadiness,
  FleetLoginReadinessSchema,
  type FleetRenewal,
  type FleetRenewalRequest,
  FleetRenewalRequestSchema,
  FleetRenewalSchema,
  type HarnessLoginFlow,
  HarnessLoginFlowSchema,
  type HarnessLoginStartRequest,
  HarnessLoginStartRequestSchema,
  type HarnessLoginSubmission,
  HarnessLoginSubmissionSchema,
  HarnessLoginSubmitRequestSchema,
  OPERATOR_UNLOCK_HEADER,
  type UsageAccountView,
  type UsageFeedView,
  UsageFeedViewSchema,
} from '@ferretry/protocol';
import type { FleetClient } from './fleet-api.ts';

export const FLEET_LOGIN_PATH = '/v1/fleet/login';

/** Headers for a governed caller that holds an unlock, and nothing extra for one that does not. */
const unlockHeaders = (unlock: string | undefined): Record<string, string> =>
  unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock };

const flowPath = (flowId: string): string => `${FLEET_LOGIN_PATH}/${encodeURIComponent(flowId)}`;

/**
 * Which provider sign-ins this host has, and what each one needs.
 *
 * `fleet.use`, so this read is the one part of the surface a caller who may only inspect can see. It is
 * what the whole feature was blocked on: no route returned a credential classification, so a UI had no
 * way to say WHICH accounts need signing in — only that some session's quota readout said `auth!`.
 */
export const readFleetLoginReadiness = async (client: FleetClient, unlock?: string): Promise<FleetLoginReadiness> =>
  await client.request(FLEET_LOGIN_PATH, FleetLoginReadinessSchema, { headers: unlockHeaders(unlock) });

/**
 * Starts one identity's sign-in.
 *
 * TWO DIFFERENT USES OF ONE SECRET, exactly as the fleet's proposal apply has. `unlock` is the token a
 * mint produced and it travels in the header the dispatcher reads for every governed route, so a locked
 * caller stops being locked. `operatorPassword` is the per-change confirmation and is the PASSWORD
 * ITSELF, proved again against this one sign-in — which is why a borrowed unlock is not by itself enough
 * to re-point somebody's fleet at another provider account. Neither is persisted or echoed anywhere.
 */
export const startHarnessLogin = async (
  client: FleetClient,
  request: HarnessLoginStartRequest,
  unlock?: string,
): Promise<HarnessLoginFlow> =>
  await client.request(FLEET_LOGIN_PATH, HarnessLoginFlowSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...unlockHeaders(unlock) },
    body: JSON.stringify(HarnessLoginStartRequestSchema.parse(request)),
  });

/** Re-reads one live sign-in. Polled, because the person is acting somewhere this browser cannot see. */
export const readHarnessLoginFlow = async (
  client: FleetClient,
  flowId: string,
  unlock?: string,
): Promise<HarnessLoginFlow> =>
  await client.request(flowPath(flowId), HarnessLoginFlowSchema, { headers: unlockHeaders(unlock) });

/**
 * Forwards the one value a person brings back.
 *
 * WRITE-ONLY AND SINGLE-USE. It travels in a BODY because a query parameter reaches every proxy's access
 * log, and the caller is expected to clear it from its own state before this promise settles: an
 * authorization code must not sit in a rendered tree, a retry affordance, or a screenshot.
 */
export const submitHarnessLoginCode = async (
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

export const FLEET_RENEW_PATH = '/v1/fleet/renew';

/**
 * Asks one account's credential to renew itself.
 *
 * THE OTHER HALF OF THIS SURFACE, and the half that was missing. This browser could start a sign-in and
 * could never renew — so an account whose access token had merely aged out, with a good refresh token
 * beside it, had exactly one remote remedy here: a full sign-in, spending a person's browser approval
 * to replace a credential that could have rotated itself.
 *
 * IT IS NOT A FLOW. There is nothing to poll, nothing to bring back and no window to expire: the host
 * drives the harness down an authenticated path that invokes no model, and the harness rewrites its own
 * store. One call, one answer — which is why there is no `flowId` anywhere in this signature.
 *
 * The unlock and the password are the two different uses of one secret that `startHarnessLogin`
 * describes, spent the same way and for the same reason: from off that machine this rewrites a
 * credential in a home on it.
 */
export const renewFleetCredential = async (
  client: FleetClient,
  request: FleetRenewalRequest,
  unlock?: string,
): Promise<FleetRenewal> =>
  await client.request(FLEET_RENEW_PATH, FleetRenewalSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...unlockHeaders(unlock) },
    body: JSON.stringify(FleetRenewalRequestSchema.parse(request)),
  });

/** Ends one sign-in and the harness child behind it. */
export const cancelHarnessLogin = async (
  client: FleetClient,
  flowId: string,
  unlock?: string,
): Promise<HarnessLoginFlow> =>
  await client.request(flowPath(flowId), HarnessLoginFlowSchema, {
    method: 'DELETE',
    headers: unlockHeaders(unlock),
  });

/**
 * The daemon's CACHED account feed, keyed by the wrapper name it reports each account under.
 *
 * ## THIS IS A SECOND READER, NEVER A SECOND MEASUREMENT
 *
 * `/v1/usage` serves whatever the daemon-wide feed already collected — a scrape costs no provider call.
 * `src/lib/usage-store.ts` polls the same path for session badges, and reading it here as well cannot
 * produce a different answer: there is one collection behind both, so two readers see one snapshot.
 * What would be a second answer is a second PROBE, and there is none.
 *
 * ## THE JOIN KEY IS THE WRAPPER NAME
 *
 * The feed keys each row by `agent`, the executable name a session is launched with, and the sign-in
 * readiness row publishes the same name for exactly this join. Neither side derives a basename.
 *
 * The path belongs to the usage feed rather than to this feature; it is READ here, not owned.
 */
export const USAGE_FEED_PATH = '/v1/usage';

export const readDaemonUsageFeed = async (client: FleetClient): Promise<UsageFeedView> =>
  await client.request(USAGE_FEED_PATH, UsageFeedViewSchema);

/** The feed as a lookup a sign-in surface can join onto its own rows. */
export const usageByWrapper = (feed: UsageFeedView): ReadonlyMap<string, UsageAccountView> =>
  new Map(feed.accounts.map(account => [account.agent, account] as const));
