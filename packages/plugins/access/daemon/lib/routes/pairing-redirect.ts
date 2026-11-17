/**
 * `POST /v1/pair/redirect`: the daemon writes the page `fy pair --open` hands the browser.
 *
 * WHY THE DAEMON AND NOT THE CLI. The page holds a live pairing code, and its tree (`pairing-redirects`) is a private
 * place of Access. A file made through the DAEMON's state port is pinned by identity before the write returns; a file
 * the CLI's own state port makes is pinned only at the fence index's next look, within 250 ms, and in that window a
 * root call that reaches an alias of the new file (a hard link in a hard-link root, a bind mount) answers from the
 * snapshot kept before it. So the CLI sends the page and the daemon makes it.
 *
 * WHO MAY ASK. Only the host's own admin credential (`minimum: 'admin-token'`, the route table), and only when it
 * ARRIVED on the host (`privilegedOnly`, decided from the carrier): the admin bearer carried over a relay, a tunnel or
 * WebRTC is refused with 403 before this handler runs, so a caller that is not the machine cannot make the daemon write
 * a file into its private state. The body is the page and nothing else; the daemon names the directory itself, so a
 * caller never chooses a path.
 */
import {
  type ApiRoute,
  errorResponse,
  jsonResponse,
  PAIRING_REDIRECT_PAGE_MAX_CHARS,
  PairingRedirectRequestSchema,
  PairingRedirectResponseSchema,
  parseBody,
} from '../wire.ts';

/** What the route needs of the state: one call that makes the directory and the page, pinned, and names the directory. */
export interface PairingRedirectWriter {
  /** Makes a fresh private directory holding `page`, pinned before it returns; rejects when it cannot. */
  write(page: string): Promise<string>;
}

export function pairingRedirectRoutes(writer: PairingRedirectWriter): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/pair/redirect',
      minimum: 'admin-token',
      privilegedOnly: true,
      caller: 'person',
      noStore: true,
      handle: async ({ request }) => {
        // The read is bounded before the schema sees it: the page's own cap in characters (a character is at most six
        // bytes once JSON-escaped, `\u00XX`), plus the JSON envelope around it.
        const { page } = await parseBody(request, PairingRedirectRequestSchema, {
          maxBytes: PAIRING_REDIRECT_PAGE_MAX_CHARS * 6 + 64,
        });
        try {
          return jsonResponse(PairingRedirectResponseSchema.parse({ directory: await writer.write(page) }), 201);
        } catch (error) {
          // The sentence of a refusal the state made (a private file that could not be pinned) is its own; anything
          // else says only that the page was not made, never a path.
          if (typeof error === 'object' && error !== null && 'status' in error) throw error;
          return errorResponse(500, 'the pairing page could not be made', 'pairing_redirect_failed');
        }
      },
    },
  ];
}
