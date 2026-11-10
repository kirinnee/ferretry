import type { ApiRequest, CallStanding } from '@ferretry/kernel/contract';
import type { MountRoute, RouteContext } from '../../daemon/seams/api.ts';

/** What a mounted route is called with: only the parts the handlers read. */
export interface CallSpec {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** A JSON body. */
  readonly body?: unknown;
  /** A body sent as written, for a body that is not JSON. */
  readonly rawBody?: string;
  readonly actor?: string;
  /** Gate's whole standing (actor, credential, …), built with Gate's own testing helpers; wins over `actor`. */
  readonly standing?: CallStanding;
}

/** The context Gate would hand a mounted route, with the standing a test names. */
export const callOf = (spec: CallSpec = {}): RouteContext => {
  const text = spec.rawBody ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
  const request = {
    method: 'POST',
    path: '/',
    query: new Map(
      Object.entries(spec.query ?? {}).map(([name, value]) => [name, typeof value === 'string' ? [value] : [...value]]),
    ),
    headers: new Map(Object.entries(spec.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    text: async () => text,
  } as unknown as ApiRequest;
  return {
    request,
    params: new Map(Object.entries(spec.params ?? {})),
    actor: spec.actor,
    ...spec.standing,
  } as unknown as RouteContext;
};

/** The one route a table mounts at `method path`. */
const routeOf = (routes: readonly MountRoute[], method: string, path: string): MountRoute => {
  const found = routes.find(route => route.method === method && route.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found;
};

/** Calls a route and returns the status and the parsed JSON body. */
export const answerOf = async (
  routes: readonly MountRoute[],
  method: string,
  path: string,
  spec: CallSpec = {},
): Promise<{ status: number; json: unknown }> => {
  const response = await routeOf(routes, method, path).handle(callOf(spec));
  return { status: response.status, json: response.body === '' ? undefined : JSON.parse(response.body) };
};

export interface Refusal {
  readonly status: number;
  readonly code?: string;
  readonly message: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** The refusal a call throws. */
export const refusalOf = async (
  routes: readonly MountRoute[],
  method: string,
  path: string,
  spec: CallSpec = {},
): Promise<Refusal> => {
  try {
    await routeOf(routes, method, path).handle(callOf(spec));
  } catch (error) {
    return error as Refusal;
  }
  throw new Error(`${method} ${path} was expected to refuse`);
};
