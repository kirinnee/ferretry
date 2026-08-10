import {
  type ApiRequest,
  type ApiResponse,
  headersFrom,
  queryFrom,
  readBoundedBody,
} from '../../../src/lib/api/index.ts';

/**
 * What a case observed about the body read, so a bound can be asserted on its own terms.
 *
 * `consumed` is the load-bearing one: proving that a declared oversize was refused means proving no
 * piece of the body was ever produced, which a status code alone cannot show.
 */
export interface BodyReads {
  /** The bound asked for on each read, in order; `undefined` for an unbounded read. */
  readonly limits: (number | undefined)[];
  /** Whether a single piece of the body was ever produced. */
  consumed: boolean;
  /** Whether the rest of the body was abandoned, which every refusal owes the sender. */
  discarded: boolean;
}

export function bodyReads(): BodyReads {
  return { limits: [], consumed: false, discarded: false };
}

export interface RequestOverrides {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: readonly (readonly [string, string])[];
  readonly clientAddress?: string;
  readonly loopback?: boolean;
  /** An unforgeable carrier proof for an anonymous public privileged-only route. */
  readonly privilegedLoopback?: boolean;
  readonly body?: string;
  /** Bytes per piece for a bounded read, so a case can drive a body that arrives in installments. */
  readonly bodyPieceBytes?: number;
  /** Makes the body reader fail, standing in for a client that vanished mid-upload. */
  readonly unreadableBody?: boolean;
  /** Collects what the read was asked for and whether it happened. */
  readonly reads?: BodyReads;
  /** The caller's cancellation, for a route long enough to be worth abandoning. */
  readonly signal?: AbortSignal;
}

/**
 * An `ApiRequest` a unit case fully controls.
 *
 * A bounded read goes through the SAME `readBoundedBody` the Bun adapter uses, differing only in
 * where the pieces come from. That is deliberate: the bound is one policy with two sources, and a
 * fake that re-implemented it would prove the fake instead of the daemon. `content-length` is read
 * from the header map exactly as the adapter reads it, so a case can forge one or send none.
 */
export function request(overrides: RequestOverrides = {}): ApiRequest {
  const headers = headersFrom(overrides.headers ?? {});
  const reads = overrides.reads;
  return {
    method: overrides.method ?? 'GET',
    path: overrides.path ?? '/healthz',
    query: queryFrom(overrides.query ?? []),
    headers,
    clientAddress: overrides.clientAddress,
    loopback: overrides.loopback ?? false,
    privilegedLoopback: overrides.privilegedLoopback,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    text: async (limitBytes?: number) => {
      reads?.limits.push(limitBytes);
      if (overrides.unreadableBody === true) throw new Error('the connection dropped');
      const body = overrides.body ?? '';
      if (limitBytes === undefined) {
        if (reads !== undefined) reads.consumed = true;
        return body;
      }
      return await readBoundedBody(
        {
          declaredLength: headers.get('content-length'),
          chunks: () => pieces(body, overrides.bodyPieceBytes, reads),
          discard: async () => {
            if (reads !== undefined) reads.discarded = true;
          },
        },
        limitBytes,
      );
    },
  };
}

/** The body in installments, produced only once something iterates them. */
async function* pieces(body: string, pieceBytes: number | undefined, reads?: BodyReads): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  const step = pieceBytes ?? Math.max(bytes.byteLength, 1);
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    if (reads !== undefined) reads.consumed = true;
    yield bytes.subarray(offset, offset + step);
  }
}

/** Parses a JSON response body. Fails loudly rather than returning `unknown` on a non-JSON body. */
export function jsonBody(response: ApiResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

export const fixedClock = (nowMs: number) => ({ now: () => nowMs });
