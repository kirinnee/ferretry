import type { IFyApiClient } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';

/** The only client capability the fallback consumes. */
export type WireApiClient = Pick<IFyApiClient, 'request'>;

/**
 * Clients that have been told by their daemon that it does not know the agenda routes. One client is
 * one daemon base URL, so this is "per daemon, for the rest of the process" without a URL key — and
 * every gateway sharing a client shares the answer.
 */
const OLDER_DAEMONS = new WeakSet<object>();

/** True when this daemon answered "no such route": the one reply that says it predates the agenda wire. */
function isUnknownRoute(error: unknown): boolean {
  return error instanceof FyHttpError && error.status === 404 && error.code === 'unknown_route';
}

/**
 * Dial the agenda route; if the daemon says it has no such route, dial the older one ONCE and remember it.
 *
 * The CLI is short-lived and does not read `/v1/health` per call, so the daemon's `unknown_route` reply is
 * how it learns the daemon is older (docs/agenda.md § Compatibility). An `unknown_route` ran no handler,
 * so repeating the request on the older route cannot apply it twice. Any other failure — a 404 from a
 * handler, a 5xx, a refusal — is the answer, never a reason to fall back.
 */
export async function requestWithRouteFallback<T>(
  client: WireApiClient,
  routes: { readonly current: string; readonly legacy: string },
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  if (OLDER_DAEMONS.has(client)) return await client.request(routes.legacy, schema, init);
  try {
    return await client.request(routes.current, schema, init);
  } catch (error) {
    if (!isUnknownRoute(error)) throw error;
    OLDER_DAEMONS.add(client);
    return await client.request(routes.legacy, schema, init);
  }
}
