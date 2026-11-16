import type { CallContext, CallStanding } from '@ferretry/kernel/contract';

/** What a handler test sends: path parameters, query, headers, a body, and optionally Gate's standing. */
export interface RequestOf {
  readonly method?: string;
  readonly path?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** A string is sent as is; anything else as JSON. */
  readonly body?: unknown;
  readonly standing?: CallStanding;
  readonly signal?: AbortSignal;
}

/**
 * A call as a keyed manifest handler sees it, with the kernel's request shape (`query` is a map of value lists).
 * The route spine (minimum, caller, capability, audit) is not here: that is the kernel's, tested with a host.
 */
export function requestOf(spec: RequestOf = {}): CallContext {
  const text = spec.body === undefined ? '' : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
  const query = new Map<string, readonly string[]>(
    Object.entries(spec.query ?? {}).map(([name, value]) => [name, typeof value === 'string' ? [value] : value]),
  );
  return {
    params: new Map(Object.entries(spec.params ?? {})),
    request: {
      method: spec.method ?? 'GET',
      path: spec.path ?? '/',
      headers: new Headers(spec.headers ?? {}),
      query,
      signal: spec.signal ?? new AbortController().signal,
      text: async () => text,
    },
    // Gate's standing is spread into the context (CallContext = request + params + Readonly<Standing>).
    ...(spec.standing ?? {}),
  } as unknown as CallContext;
}

/** The parsed JSON body of a response. */
export const jsonOf = <T = Record<string, unknown>>(response: { readonly body: unknown }): T =>
  (typeof response.body === 'string' ? JSON.parse(response.body) : response.body) as T;
