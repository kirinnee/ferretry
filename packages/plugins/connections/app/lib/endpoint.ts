// Copied endpoint parser from relay/connection.ts; matched to the published CSP.
import { z } from 'zod';
const PUBLISHED_CSP_INSECURE_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Exact match is total here because the caller passes `URL.hostname`, which has already lowercased
 * an ASCII name and would have carried brackets only for an address this set does not hold.
 */
function isLoopbackUnderPublishedCsp(hostname: string): boolean {
  return PUBLISHED_CSP_INSECURE_HOSTS.has(hostname);
}

/**
 * A socket address this protocol will dial.
 *
 * Secure schemes anywhere; insecure schemes only against the two hosts the published site's
 * content-security-policy will actually let a browser dial. Accepting a wider loopback here would
 * store a carrier the browser then refuses to open, and refuses BEFORE the request exists, so the
 * person holding the phone gets a dead connection with nothing to read.
 */
export const SocketEndpointSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'endpoint is not a URL' });
      return z.NEVER;
    }
    const dialableInsecure = isLoopbackUnderPublishedCsp(url.hostname);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const insecure = url.protocol === 'http:' || url.protocol === 'ws:';
    if (!secure && !(insecure && dialableInsecure)) {
      context.addIssue({
        code: 'custom',
        message: 'endpoint must be wss/https, or ws/http on localhost or the loopback address',
      });
      return z.NEVER;
    }
    if (url.search !== '' || url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'endpoint carries a query or fragment' });
      return z.NEVER;
    }
    return url.toString().replace(/\/$/u, '');
  });
