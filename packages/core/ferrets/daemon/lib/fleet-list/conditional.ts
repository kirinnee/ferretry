import { createHash } from 'node:crypto';
import type { ApiResponse } from '@ferretry/kernel/contract';
import type { FerretSummary } from '../../../contract/index.ts';

/**
 * THE CONDITIONAL FLEET READ (R501, R503; today's `runtime/mounts/sessions.ts` list route and `api/responses.ts`).
 *
 * Every open app re-reads the fleet on a beat, so `GET /v1/ferrets` is conditional: its tag is a digest of the exact
 * JSON served, so it moves when ANY field of any ferret moves, and an unchanged fleet costs its headers. The tag is
 * deterministic (no read time, never a version counter): two reads with nothing changed give a `304` on the second.
 *
 * The cost is the serialisation, so the route keeps ONE previous answer: a list whose elements are, one for one,
 * the very objects of the previous list is the same JSON by construction (the registry hands out the same summary
 * object while a ferret has not moved), and its body and tag are reused. A changed list renders only its new
 * summaries ({@link renderFerretList}). Identity may miss a body that happens to be equal, never serve one that
 * differs.
 */

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** A strong tag over the exact body: `"` + base64url SHA-256 + `"` (today's `entityTag`). */
export function entityTag(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

/** Whether `If-None-Match` names this tag. GET compares weakly (RFC 9110 §13.1.2), so `W/` is ignored. */
function namesTag(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(',')
    .map(candidate => candidate.trim())
    .some(candidate => candidate === '*' || candidate.replace(/^W\//u, '') === etag);
}

/** A response made conditional: it carries `etag`, and a request naming it is answered `304` with no body. */
function conditionalWithTag(response: ApiResponse, etag: string, ifNoneMatch: string | undefined): ApiResponse {
  const headers = new Map(response.headers);
  headers.set('etag', etag);
  if (ifNoneMatch !== undefined && namesTag(ifNoneMatch, etag)) return { status: 304, headers, body: '' };
  return { ...response, headers };
}

/** The JSON of each summary served, held exactly as long as the summary object lives. */
const rendered = new WeakMap<FerretSummary, string>();

/** The list's JSON from each summary's own JSON: byte for byte `JSON.stringify(list)`. */
function renderFerretList(list: readonly FerretSummary[]): string {
  const parts = new Array<string>(list.length);
  for (const [at, summary] of list.entries()) {
    let json = rendered.get(summary);
    if (json === undefined) {
      json = JSON.stringify(summary);
      rendered.set(summary, json);
    }
    parts[at] = json;
  }
  return `[${parts.join(',')}]`;
}

const sameList = (left: readonly FerretSummary[], right: readonly FerretSummary[]): boolean =>
  left.length === right.length && left.every((summary, at) => summary === right[at]);

/** The list route's memory: one previous answer. */
export class ConditionalFleetList {
  private previous:
    | { readonly list: readonly FerretSummary[]; readonly response: ApiResponse; readonly etag: string }
    | undefined;

  answer(list: readonly FerretSummary[], ifNoneMatch: string | undefined): ApiResponse {
    if (this.previous === undefined || !sameList(this.previous.list, list)) {
      const body = renderFerretList(list);
      const response: ApiResponse = { status: 200, headers: new Map([['content-type', JSON_CONTENT_TYPE]]), body };
      this.previous = { list, response, etag: entityTag(body) };
    }
    return conditionalWithTag(this.previous.response, this.previous.etag, ifNoneMatch);
  }
}
