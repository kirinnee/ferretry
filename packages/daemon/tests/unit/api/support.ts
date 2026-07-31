import { headersFrom, queryFrom, type ApiRequest, type ApiResponse } from '../../../src/lib/api/index.ts';

export interface RequestOverrides {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: readonly (readonly [string, string])[];
  readonly loopback?: boolean;
  readonly body?: string;
  /** Makes the body reader fail, standing in for a client that vanished mid-upload. */
  readonly unreadableBody?: boolean;
}

export function request(overrides: RequestOverrides = {}): ApiRequest {
  return {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/healthz',
    query: queryFrom(overrides.query ?? []),
    headers: headersFrom(overrides.headers ?? {}),
    loopback: overrides.loopback ?? false,
    text: async () => {
      if (overrides.unreadableBody === true) throw new Error('the connection dropped');
      return overrides.body ?? '';
    },
  };
}

/** Parses a JSON response body. Fails loudly rather than returning `unknown` on a non-JSON body. */
export function jsonBody(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

export const fixedClock = (nowMs: number) => ({ now: () => nowMs });
