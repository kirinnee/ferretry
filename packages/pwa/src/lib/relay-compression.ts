import {
  TUNNEL_BASE64URL_TRANSFER,
  TUNNEL_CONTENT_ENCODING_HEADER,
  TUNNEL_GZIP_ENCODING,
  TUNNEL_TRANSFER_ENCODING_HEADER,
} from '@ferretry/protocol';
import { fromBase64Url } from '@ferretry/relay';

/**
 * A RELAYED ANSWER IS NOT A BROWSER FETCH, so nothing decodes it for us (`docs/relay-protocol.md` §14,
 * "A compressed answer"). A direct `fetch` strips `Content-Encoding` itself; a `res` record arrives as a
 * string, and a body the daemon compressed arrives as gzip bytes in unpadded base64url under two
 * headers. This reads them back into the plain text the daemon's route produced, and removes the two
 * headers so every caller reads the answer it always did.
 *
 * The daemon only compresses for a caller that sent `accept-encoding: gzip`, so a browser without
 * `DecompressionStream` simply never asks ({@link acceptEncodingHeader}) and gets plain bodies.
 */
function canDecodeGzip(): boolean {
  return typeof DecompressionStream === 'function';
}

/** The request header that asks for a compressed answer: empty where this browser could not read one. */
export function acceptEncodingHeader(): Readonly<Record<string, string>> {
  return canDecodeGzip() ? { 'accept-encoding': TUNNEL_GZIP_ENCODING } : {};
}

export interface DecodableAnswer {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Whether an answer is a compressed one. Header names are compared lowercased: the daemon writes them so. */
function isCompressed(headers: Readonly<Record<string, string>>): boolean {
  return headers[TUNNEL_CONTENT_ENCODING_HEADER]?.toLowerCase() === TUNNEL_GZIP_ENCODING;
}

/**
 * The answer with its body decoded, or the same answer when it was never compressed.
 *
 * A body that claims to be compressed and is not — bad base64url, a transfer encoding this app does not
 * know, bytes gzip refuses — throws. Handing the caller the still-encoded text as if it were JSON would
 * be a fabricated answer, which is the one failure the request path exists to avoid.
 */
export async function decodeCompressedAnswer<T extends DecodableAnswer>(answer: T): Promise<T> {
  if (!isCompressed(answer.headers)) return answer;
  if (answer.headers[TUNNEL_TRANSFER_ENCODING_HEADER]?.toLowerCase() !== TUNNEL_BASE64URL_TRANSFER)
    throw new Error('the daemon sent a compressed answer in an encoding this app cannot read');
  const bytes = fromBase64Url(answer.body);
  if (bytes === null) throw new Error('the daemon sent a compressed answer that is not valid base64url');
  let text: string;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } catch {
    throw new Error('the daemon sent a compressed answer that could not be decompressed');
  }
  const {
    [TUNNEL_CONTENT_ENCODING_HEADER]: _encoding,
    [TUNNEL_TRANSFER_ENCODING_HEADER]: _transfer,
    ...headers
  } = answer.headers;
  return { ...answer, headers, body: text };
}
