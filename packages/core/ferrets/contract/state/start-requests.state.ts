import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { type FerretId, FerretIdSchema } from '../ids.ts';

/**
 * Which ferret each start request id produced (today's start retry contract, `session-control.ts`): the protocol
 * client posts a start with a request id, retries the identical POST on a transport error, and, if that fails too,
 * asks `GET /v1/ferrets/by-request/:requestId?payload=<sha-256 of the body>` which ferret it started. A start whose
 * answer was lost may well have succeeded, and without this the person is handed a transport error beside a ferret
 * they never learn is running.
 *
 * The digest is of the exact body BYTES the client sent (a re-serialization of the parsed value might not hash the
 * same), and it is the authorization: a request id is chosen by the client and travels in a header, so answering it
 * alone would let any caller enumerate other callers' starts.
 *
 * Private to Ferrets (`state/ferrets/start-requests.json`), bounded to the newest {@link MAX_START_REQUESTS}.
 */
const MAX_START_REQUESTS = 1_000;

const StartRequestEntrySchema = z.strictObject({
  requestId: z.string().min(1).max(256),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  ferret: FerretIdSchema,
  at: z.string().min(1),
});
export type StartRequestEntry = z.infer<typeof StartRequestEntrySchema>;

const StartRequestsSchema = z.strictObject({
  requests: z.array(StartRequestEntrySchema).max(MAX_START_REQUESTS),
});
export type StartRequests = z.infer<typeof StartRequestsSchema>;

export const StartRequestsFile = defineState({
  name: 'start-requests',
  path: 'start-requests.json',
  store: 'json',
  format: 1,
  schema: StartRequestsSchema,
});

/**
 * The text a start's digest is taken over: the body the client sent, minus the request-only admission override
 * `allowScratch` (it decides whether a start is let through, never WHICH start it is, so the same request id sent again
 * with it flipped is a replay, not a conflict). One function for the client's recovery digest and the daemon's, so they
 * cannot disagree. A body without it is returned byte for byte; one that is not a JSON object is left as it came.
 */
export function startFingerprintText(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null || Array.isArray(body) || !('allowScratch' in body)) return text;
    const { allowScratch: _override, ...rest } = body as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return text;
  }
}

/** What a request id already says about a start: nothing, the same body (replay), or another body (conflict). */
export type StartRequestLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'same'; readonly ferret: FerretId }
  | { readonly kind: 'conflict' };

export function lookupStartRequest(
  held: StartRequests | undefined,
  requestId: string,
  digest: string,
): StartRequestLookup {
  const entry = held?.requests.find(request => request.requestId === requestId);
  if (entry === undefined) return { kind: 'none' };
  return entry.digest === digest ? { kind: 'same', ferret: entry.ferret as FerretId } : { kind: 'conflict' };
}

/** The ledger with one more start, the oldest dropped past the bound. */
export function withStartRequest(held: StartRequests | undefined, entry: StartRequestEntry): StartRequests {
  const kept = (held?.requests ?? []).filter(request => request.requestId !== entry.requestId);
  return { requests: [...kept, entry].slice(-MAX_START_REQUESTS) };
}
