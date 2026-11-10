import type { ApiResponse } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';

/** What a route table answers to one direct call: the response, or the `ApiError` its handler threw. */
export type Answered = { readonly response: ApiResponse; readonly error?: undefined } | { readonly error: ApiError };

export interface RouteCall {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: readonly (readonly [string, string])[];
  readonly body?: unknown;
  /** The caller is a ferret (its token class), not the owner. */
  readonly ferret?: boolean;
  /** The caller is a governed device; `fresh` says whether its fresh passkey proof claims. */
  readonly governed?: { readonly fresh: boolean };
  readonly headers?: Readonly<Record<string, string>>;
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handle: (context: never) => Promise<ApiResponse>;
}

/**
 * Calls one route's handler as the kernel would hand it a call: a request, raw path parameters and Gate's standing.
 * The standing is built here and only here, so a test states who is calling and nothing else.
 */
export async function callRoute(
  routes: readonly Route[],
  method: string,
  path: string,
  call: RouteCall = {},
): Promise<Answered> {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (route === undefined) throw new Error(`no route ${method} ${path}`);
  const query = new Map<string, string[]>();
  for (const [name, value] of call.query ?? []) query.set(name, [...(query.get(name) ?? []), value]);
  const context = {
    request: {
      method,
      path,
      query,
      headers: new Map(Object.entries(call.headers ?? {})),
      arrival: { kind: 'local', privileged: false },
      text: async () => JSON.stringify(call.body ?? {}),
    },
    params: new Map(Object.entries(call.params ?? {})),
    ...(call.ferret === true ? { credential: { tokenClass: 'ferret', ferret: 'F1936' } } : {}),
    ...(call.governed === undefined
      ? {}
      : {
          governance: { governed: true },
          claimFreshStepUp: () => call.governed?.fresh === true,
        }),
  };
  try {
    return { response: await route.handle(context as never) };
  } catch (error) {
    if (error instanceof ApiError) return { error };
    throw error;
  }
}

export const bodyOf = (answered: Answered): unknown => {
  if (answered.error !== undefined) throw new Error(`refused: ${answered.error.message}`);
  return JSON.parse(answered.response.body);
};

/** A subsystem service whose every method answers `{ called: name, args }`, or throws what `failWith` says. */
export function recordingService<T extends object>(
  failWith?: Error,
): { readonly service: T; readonly calls: { readonly name: string; readonly args: readonly unknown[] }[] } {
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const service = new Proxy(
    {},
    {
      get:
        (_target, name) =>
        async (...args: unknown[]) => {
          calls.push({ name: String(name), args });
          if (failWith !== undefined) throw failWith;
          return { called: String(name) };
        },
    },
  ) as T;
  return { service, calls };
}
