import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiRoute } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { request } from '../../api/support.ts';

/** A ferret on its OWN session credential, exactly as the boundary hands it to a handler. */
const FERRET_OWN_CALLER = {
  credential: { kind: 'authenticated', tokenClass: 'session', sessionId: 's1' } as AuthenticatedCredential,
  actor: 'peer:s1',
} as const;

/**
 * Calls a route's HANDLER directly, as if the boundary had let the caller through — the way to prove a
 * handler's own second line refuses a ferret, which the boundary now refuses first on a `person` route.
 */
export async function handleDirectly(
  routes: readonly ApiRoute[],
  method: string,
  path: string,
  caller: { readonly credential: AuthenticatedCredential; readonly actor: string } = FERRET_OWN_CALLER,
  body?: unknown,
): Promise<{ readonly status: number; readonly code?: string; readonly message?: string }> {
  const found = new ApiRouter(routes).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  try {
    const response = await found.route.handle({
      request: request({
        method,
        path,
        loopback: true,
        privilegedLoopback: true,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      params: found.params,
      actor: caller.actor,
      credential: caller.credential,
      presentation: { loopback: true, adminToken: false, actor: caller.actor, stepUp: false, freshStepUp: false },
      governance: { governed: false } as never,
    });
    const parsed = JSON.parse(response.body) as { readonly code?: string; readonly error?: string };
    return {
      status: response.status,
      ...(parsed.code === undefined ? {} : { code: parsed.code }),
      ...(parsed.error === undefined ? {} : { message: parsed.error }),
    };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  }
}
