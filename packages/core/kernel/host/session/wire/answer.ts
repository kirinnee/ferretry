/**
 * One answer as the sealed records that carry it, each with its PERMIT: the synchronous final check the
 * session layer asks inside `next()`, after queueing and sealing and immediately before the carrier takes the
 * bytes (§7.3, guarded publication).
 *
 * A response with `late` can change between the moment it was spelled and the moment it leaves. The permit
 * asks `finalised` again and re-renders: a record whose bytes are no longer what the answer says now is
 * dropped unsent and its session ends (R516, R517). A response with no `late` has no permit; it cannot change.
 */

import { type ApiResponse, finalised } from '../../../contract/http.ts';
import { isPublishedResponse } from './publication.ts';
import { encodeDaemonRecord, responseRecords } from './records.ts';

export interface AnswerRecord {
  readonly plaintext: Uint8Array;
  readonly part?: true;
  readonly permit?: () => boolean;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  // Every byte is compared, whatever the first difference: the comparison takes the same time for a changed
  // and an unchanged answer of one length (R516).
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

/** A private copy, so edits through a returned map or byte array cannot alter what was rendered. */
function snapshot(response: ApiResponse): ApiResponse {
  return {
    status: response.status,
    headers: new Map(response.headers),
    body: response.body,
    ...(response.gzip === undefined ? {} : { gzip: response.gzip.slice() }),
  };
}

function sameAnswer(left: ApiResponse, right: ApiResponse): boolean {
  if (left.status !== right.status) return false;
  // Header order affects the JSON envelope, so equality must preserve it.
  const entries = [...right.headers];
  if (left.headers.size !== entries.length) return false;
  if (![...left.headers].every(([key, value], index) => entries[index]?.[0] === key && entries[index]?.[1] === value))
    return false;
  return left.body === right.body;
}

export function answerRecords(id: number, response: ApiResponse): readonly AnswerRecord[] {
  const initial = finalised(response);
  let current = response.late === undefined || isPublishedResponse(initial) ? initial : snapshot(initial);
  const render = (answer: ApiResponse): readonly Uint8Array[] => responseRecords(id, answer).map(encodeDaemonRecord);
  let encoded = render(current);
  return encoded.map((plaintext, index) => ({
    plaintext,
    ...(index === 0 ? {} : { part: true as const }),
    ...(response.late === undefined
      ? {}
      : {
          permit: (): boolean => {
            try {
              const next = finalised(response);
              // Only kernel publications are immutable. Plain late sources can edit the same object or map.
              if (
                next !== current &&
                (isPublishedResponse(current) || isPublishedResponse(next) || !sameAnswer(current, next))
              ) {
                current = isPublishedResponse(next) ? next : snapshot(next);
                encoded = render(current);
              }
              const again = encoded[index];
              return again !== undefined && sameBytes(again, plaintext);
            } catch {
              // A throw in the final check withholds (§7.3).
              return false;
            }
          },
        }),
  }));
}
