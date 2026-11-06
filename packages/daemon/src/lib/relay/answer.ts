import { finalised, type ApiResponse } from '../api/http.ts';
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

/** Only facts that affect the wire. Copy the mutable containers so in-place edits are seen too. */
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
  if (left.gzip === undefined) return right.gzip === undefined && left.body === right.body;
  return right.gzip !== undefined && sameBytes(left.gzip, right.gzip);
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
  let current = response.late === undefined ? initial : snapshot(initial);
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
              if (!sameAnswer(current, next)) {
                current = snapshot(next);
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
