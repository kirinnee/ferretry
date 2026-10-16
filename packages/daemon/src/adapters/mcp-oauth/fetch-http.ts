/**
 * The MCP sign-in's network: `fetch`, bounded, and never following a redirect.
 *
 * - **No redirect is followed.** A token endpoint that redirects is not one this daemon trusts to receive
 *   a code and a verifier, and a metadata address that redirects would move discovery somewhere the
 *   checks in `lib/mcp-oauth/discovery.ts` never saw. A 3xx is answered as itself.
 * - **Time and size are bounded**, so a slow or enormous answer cannot hold a sign-in, or the daemon,
 *   hostage.
 * - **Nothing is logged.** A request carries a code, a verifier or a refresh token; a failure raises a
 *   bare word and never the address or the body.
 */
import type { McpOAuthHttp, McpOAuthHttpRequest, McpOAuthHttpResponse } from '../../lib/mcp-oauth/ports.ts';

/** How long one request may take. */
export const MCP_OAUTH_HTTP_TIMEOUT_MS = 15_000;

/** The most of a body this reads. Metadata and token answers are a few kilobytes. */
export const MCP_OAUTH_HTTP_MAX_BYTES = 256 * 1024;

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MCP_OAUTH_HTTP_MAX_BYTES) {
      await reader.cancel();
      throw new Error('mcp sign-in response too large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class FetchMcpOAuthHttp implements McpOAuthHttp {
  constructor(
    private readonly network: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  async request(request: McpOAuthHttpRequest): Promise<McpOAuthHttpResponse> {
    let response: Response;
    try {
      response = await this.network(request.url, {
        method: request.method,
        headers: request.headers ?? {},
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(MCP_OAUTH_HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new Error('mcp sign-in request failed');
    }
    const text = await boundedText(response);
    return { status: response.status, header: name => response.headers.get(name) ?? undefined, text };
  }
}
