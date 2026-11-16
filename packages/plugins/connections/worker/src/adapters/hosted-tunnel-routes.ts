/**
 * The hosted Worker's tunnel routes — `docs/relay-protocol.md` §15, "The hosted tunnel service".
 *
 * HOSTED MODE ONLY. A self-hosted relay never calls this, so every tunnel path there falls through to
 * the rendezvous router and answers the same 404 as any other unknown path.
 *
 * The Worker's half is the boundary: it parses each public body with the wire schema, refuses a malformed
 * one as `tunnel_bad_request` before anything is stored, checks the operator bearer, and forwards to the
 * one `TUNNEL_CONTROL` object with the host it is SERVING — read from the URL of the request it received,
 * which is what a daemon signed if it discovered this service honestly. Everything else is the object's.
 */

import type { z } from 'zod';
import {
  TUNNEL_CHALLENGE_PATH,
  TUNNEL_OPERATOR_STATUS_PATH,
  TUNNEL_PROVISION_PATH,
  TUNNEL_RELEASE_PATH,
  TUNNEL_SERVICE_PATH,
  TUNNEL_SERVICE_VERSION,
  TunnelChallengeRequestSchema,
  TunnelProvisionRequestSchema,
  TunnelReleaseRequestSchema,
  TunnelServiceAdvertisementSchema,
  TunnelSettingsSchema,
} from '../lib/index.ts';
import type { HostedRelayControlNamespace } from './hosted-control.ts';
import { hostedTunnelControlStub, refusal, TUNNEL_CONTROL_ROUTES } from './hosted-tunnel-control.ts';
import { operatorRefusal } from './operator-auth.ts';

/** A provision body is a few hundred bytes; anything this large is not one. */
export const TUNNEL_REQUEST_MAX_BYTES = 8 * 1024;

const CONTROL_ORIGIN = 'https://tunnel-control.invalid';

export interface HostedTunnelEnvironment {
  readonly TUNNEL_CONTROL?: HostedRelayControlNamespace;
  readonly RELAY_OPERATOR_TOKEN?: string;
}

export function isHostedTunnelPath(pathname: string): boolean {
  return (
    pathname === TUNNEL_SERVICE_PATH ||
    pathname === TUNNEL_CHALLENGE_PATH ||
    pathname === TUNNEL_PROVISION_PATH ||
    pathname === TUNNEL_RELEASE_PATH ||
    pathname === TUNNEL_OPERATOR_STATUS_PATH
  );
}

export async function hostedTunnelFetch(request: Request, environment: HostedTunnelEnvironment): Promise<Response> {
  const url = new URL(request.url);
  switch (url.pathname) {
    case TUNNEL_SERVICE_PATH:
      return advertisement(request, environment);
    case TUNNEL_OPERATOR_STATUS_PATH:
      return operator(request, environment);
    case TUNNEL_CHALLENGE_PATH:
      return forwardPublic(request, environment, TunnelChallengeRequestSchema, body => ({
        route: TUNNEL_CONTROL_ROUTES.challenge,
        body,
      }));
    case TUNNEL_PROVISION_PATH:
      return forwardPublic(request, environment, TunnelProvisionRequestSchema, body => ({
        route: TUNNEL_CONTROL_ROUTES.provision,
        body: { host: url.host, request: body },
      }));
    default:
      return forwardPublic(request, environment, TunnelReleaseRequestSchema, body => ({
        route: TUNNEL_CONTROL_ROUTES.release,
        body: { host: url.host, request: body },
      }));
  }
}

/**
 * `GET /v1/tunnel-service`. Public, no-store, readable cross-origin (the PWA reads it to say "not set
 * up"). A deployment without the binding, or an object that cannot answer, advertises `available:
 * false` — which is exactly how a client treats a failed read, so saying it is the honest answer.
 */
async function advertisement(request: Request, environment: HostedTunnelEnvironment): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...PUBLIC_HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }
  if (request.method !== 'GET') return refusal('tunnel_bad_request', 'method not allowed');
  const control = environment.TUNNEL_CONTROL;
  const unavailable = () => publicJson({ version: TUNNEL_SERVICE_VERSION, available: false });
  if (control === undefined) return unavailable();
  try {
    const response = await hostedTunnelControlStub(control).fetch(
      new Request(`${CONTROL_ORIGIN}${TUNNEL_CONTROL_ROUTES.service}`),
    );
    const parsed = TunnelServiceAdvertisementSchema.safeParse(await response.json());
    return response.ok && parsed.success ? publicJson(parsed.data) : unavailable();
  } catch {
    return unavailable();
  }
}

async function operator(request: Request, environment: HostedTunnelEnvironment): Promise<Response> {
  const refused = operatorRefusal(request, environment.RELAY_OPERATOR_TOKEN);
  if (refused !== null) return refused;
  if (request.method !== 'GET' && request.method !== 'PUT') {
    return refusal('tunnel_bad_request', 'method not allowed');
  }
  const control = environment.TUNNEL_CONTROL;
  if (control === undefined) return refusal('tunnel_unavailable', 'this deployment has no tunnel control object');
  let body: string | undefined;
  if (request.method === 'PUT') {
    const parsed = await boundedJson(request, TunnelSettingsSchema);
    if (parsed === null) return refusal('tunnel_bad_request', 'expected { "reclaimAfterDays": 1..365 }');
    body = JSON.stringify(parsed);
  }
  const route = request.method === 'GET' ? TUNNEL_CONTROL_ROUTES.status : TUNNEL_CONTROL_ROUTES.settings;
  return toControl(control, route, request.method, body);
}

async function forwardPublic<T extends z.ZodType>(
  request: Request,
  environment: HostedTunnelEnvironment,
  schema: T,
  envelope: (body: z.infer<T>) => { readonly route: string; readonly body: unknown },
): Promise<Response> {
  if (request.method !== 'POST') return refusal('tunnel_bad_request', 'method not allowed');
  const parsed = await boundedJson(request, schema);
  if (parsed === null) return refusal('tunnel_bad_request', 'the request body does not match the tunnel protocol');
  const control = environment.TUNNEL_CONTROL;
  if (control === undefined) return refusal('tunnel_unavailable', 'this deployment has no tunnel control object');
  const forward = envelope(parsed);
  return toControl(control, forward.route, 'POST', JSON.stringify(forward.body));
}

async function toControl(
  control: HostedRelayControlNamespace,
  route: string,
  method: string,
  body: string | undefined,
): Promise<Response> {
  try {
    return await hostedTunnelControlStub(control).fetch(
      new Request(`${CONTROL_ORIGIN}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      }),
    );
  } catch {
    return refusal('tunnel_unavailable', 'the tunnel service could not be reached; try again later');
  }
}

/** The body as JSON matching `schema`, or null — including for a body larger than any real request. */
async function boundedJson<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  try {
    const text = await request.text();
    if (text.length > TUNNEL_REQUEST_MAX_BYTES) return null;
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const PUBLIC_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store, max-age=0',
} as const;

function publicJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
