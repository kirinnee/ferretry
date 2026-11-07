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
  if (left.status !== right.status || left.body !== right.body) return false;
  // Header order affects the wire envelope. A plain source may own and mutate its backing map.
  const entries = [...right.headers];
  return (
    left.headers.size === entries.length &&
    [...left.headers].every(([key, value], index) => entries[index]?.[0] === key && entries[index]?.[1] === value)
  );
}

export function answerRecords(id: number, response: ApiResponse): readonly AnswerRecord[] {
  const initial = finalised(response);
  let source = response.late === undefined || isPublishedResponse(initial) ? initial : snapshot(initial);
  const render = (answer: ApiResponse): readonly Uint8Array[] => responseRecords(id, answer).map(encodeDaemonRecord);
  let encoded = render(snapshot(source));
  return encoded.map((plaintext, index) => ({
    plaintext,
    ...(index === 0 ? {} : { part: true as const }),
    ...(response.late === undefined
      ? {}
      : {
          permit: (): boolean => {
            try {
              const next = finalised(response);
              // Only a nominal kernel publication proves immutability. Copy and compare plain sources,
              // including a source that returns the same object after editing its headers (R515–R517).
              if (
                next !== source &&
                (isPublishedResponse(source) || isPublishedResponse(next) || !sameAnswer(source, next))
              ) {
                source = isPublishedResponse(next) ? next : snapshot(next);
                encoded = render(source);
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
