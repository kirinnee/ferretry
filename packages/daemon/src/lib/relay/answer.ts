import { finalised, type ApiResponse } from '../api/http.ts';
import { isPublishedResponse } from '../api/response-generation.ts';
import { encodeTunnelMessage, tunnelResponseMessages } from './tunnel.ts';

export interface TunnelAnswerRecord {
  readonly plaintext: Uint8Array;
  readonly part?: true;
  readonly permit?: () => boolean;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Uncompressed legacy sources may still edit their headers in place. */
function snapshot(response: ApiResponse): ApiResponse {
  return {
    status: response.status,
    headers: new Map(response.headers),
    body: response.body,
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

/**
 * Encode an answer once per wire generation, while still asking its late source after EVERY seal.
 * Previously each part re-partitioned and base64-encoded the entire answer. An unchanged N-part
 * answer now costs one rendering and N encodings, including the permits. A changed source is rendered
 * once, then each permit compares its own original bytes: an unchanged prefix may still leave, but a
 * changed or missing part cannot. There is no await between that last check and the socket.
 */
export function tunnelAnswerRecords(id: number, response: ApiResponse): readonly TunnelAnswerRecord[] {
  const initial = finalised(response);
  let current = response.late === undefined || isPublishedResponse(initial) ? initial : snapshot(initial);
  const render = (answer: ApiResponse) => tunnelResponseMessages(id, answer).map(encodeTunnelMessage);
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
              return false;
            }
          },
        }),
  }));
}
