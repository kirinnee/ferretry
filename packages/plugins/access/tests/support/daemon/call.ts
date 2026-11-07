/**
 * A route call a unit case fully controls (today's `tests/unit/api/support.ts` `request()` + the dispatcher's
 * `RouteContext`). In 5.0 the kernel admits a call and Gate stamps its standing; Access's handlers only read that
 * standing, so a case builds it directly here instead of running a dispatcher:
 *
 * - `host: true` is today's `loopback` + the admin token: a LOCAL arrival (only the kernel's listener makes one; the
 *   kernel's `testArrival(owner())` stands in) with the `admin` credential and the `admin-cli` actor.
 * - `device` is today's `request.device`: the kernel-stamped `SessionPrincipal` (holder = device id, session = the
 *   app session) on a CARRIED arrival, with the `device` credential and the `device:<id>` actor.
 * - anything else is a carried call with no principal (today's admin token off loopback).
 */
import {
  ApiError,
  type ApiRequest,
  type ApiResponse,
  type CallContext,
  type CallStanding,
  type HolderId,
  errorResponse,
  headersFrom,
  queryFrom,
  type SessionId,
} from '@ferretry/kernel/contract';
import { device as deviceCaller, owner, testArrival } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import type { CapabilityGrants, CapabilityPresentation } from '@ferretry/core-gate/contract';

export interface CallOverrides {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: readonly (readonly [string, string])[];
  readonly body?: string;
  /** At the machine with the admin token (today's `loopback: true` + the admin credential). */
  readonly host?: boolean;
  /** The device a session proved (today's `request.device`). */
  readonly device?: { readonly deviceId: string; readonly appSession?: string };
  /** The transcript hash a step-up or rotation proof is bound to. */
  readonly transcriptHash?: Uint8Array;
  readonly params?: Readonly<Record<string, string>>;
  /** Overrides of the presentation Gate would stamp. */
  readonly presentation?: Partial<CapabilityPresentation>;
  /** The device's own grants as Gate read them from `credentials:device` (`null` = undetermined). */
  readonly deviceGrants?: CapabilityGrants | null;
  /** Any other standing field (`claimFreshStepUp`, `spendFreshStepUp`, `governance`, an `actor` override …). */
  readonly standing?: Partial<CallStanding>;
}

const LEASE: Instant = '2099-01-01T00:00:00.000Z' as Instant;

/** An `ApiRequest` as the kernel hands it to a handler. */
export function request(overrides: CallOverrides = {}): ApiRequest {
  const principal =
    overrides.device === undefined
      ? undefined
      : {
          kind: 'device' as const,
          holder: overrides.device.deviceId as HolderId,
          session: (overrides.device.appSession ?? `session-${overrides.device.deviceId}`) as SessionId,
          leaseUntil: LEASE,
        };
  const body = overrides.body ?? '';
  return {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/',
    query: queryFrom(overrides.query ?? []),
    headers: headersFrom(overrides.headers ?? {}),
    arrival: overrides.host === true ? testArrival(owner()) : testArrival(deviceCaller('remote')),
    ...(principal === undefined ? {} : { principal }),
    ...(overrides.transcriptHash === undefined ? {} : { transcriptHash: overrides.transcriptHash }),
    text: async (limitBytes?: number) => {
      if (limitBytes !== undefined && new TextEncoder().encode(body).byteLength > limitBytes) {
        const error = new Error('the request body is larger than this route accepts');
        error.name = 'BodyTooLargeError';
        throw error;
      }
      return body;
    },
  };
}

/** The handler's context: the request, its raw params and Gate's standing for that caller. */
export function call(overrides: CallOverrides = {}): CallContext {
  const host = overrides.host === true;
  const actor =
    overrides.standing?.actor ??
    (host ? 'admin-cli' : overrides.device === undefined ? 'admin-ui' : `device:${overrides.device.deviceId}`);
  const req = request(overrides);
  const credential = host
    ? ({ kind: 'authenticated', tokenClass: 'admin' } as const)
    : req.principal === undefined
      ? ({ kind: 'authenticated', tokenClass: 'admin' } as const)
      : ({ kind: 'authenticated', tokenClass: 'device', principal: req.principal } as const);
  const presentation: CapabilityPresentation = {
    local: host,
    adminToken: req.principal === undefined,
    actor,
    stepUp: false,
    ...(overrides.deviceGrants === undefined ? {} : { deviceGrants: overrides.deviceGrants }),
    ...overrides.presentation,
  };
  return {
    request: req,
    params: new Map(Object.entries(overrides.params ?? {})),
    actor,
    credential,
    presentation,
    ...overrides.standing,
  } as CallContext;
}

/** Parses a JSON response body. Fails loudly rather than returning `unknown` on a non-JSON body. */
export function jsonBody(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

/**
 * Runs one handler the way the kernel's dispatcher would answer it: an `ApiError` a handler throws becomes its
 * `{ error, code }` envelope (the kernel's job), so a case asserts on the response either way.
 */
export async function respond(
  routes: readonly { readonly method: string; readonly path: string; readonly handle: (call: CallContext) => Promise<ApiResponse> }[],
  key: string,
  overrides: CallOverrides = {},
): Promise<ApiResponse> {
  const [method, path] = key.split(' ') as [string, string];
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (route === undefined) throw new Error(`no route ${key}`);
  try {
    return await route.handle(call({ method, path, ...overrides }));
  } catch (error) {
    if (error instanceof ApiError)
      return errorResponse(error.status, error.message, error.code, {
        ...(error.validationIssues === undefined ? {} : { issues: error.validationIssues }),
        ...error.extra,
      });
    throw error;
  }
}
