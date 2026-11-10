/**
 * ONE-SHOT REQUESTS ABOUT HOW THIS DEVICE REACHES A MACHINE, OVER THE CARRIERS THAT INTRODUCE (`docs/relay-protocol.md`
 * §15, §16; today's `DaemonCarrierRouter.#introduce`).
 *
 * The carrier choice sits BELOW the shell's sealed session, so the router cannot send a request itself: the shell's
 * generated client does, and Connections' own half is handed that client for each paired daemon (the background view
 * that refreshes the stored carrier set). This registry keeps it. A request made through it is one of the three
 * routes below, and every one of them is a path the carrier names as CARRIER CONTROL (`CONTROL_PATHS`), so the shell
 * sends it over the daemon's own address or a rendezvous, never over the tunnel or WebRTC it is about to help dial:
 *
 * - `GET /v1/tunnel`        where is this machine's tunnel now (the tunnel lookup, R636);
 * - `PUT /v1/tunnel`        switch it (the tunnel switch);
 * - `POST /v1/webrtc/offer` signal WebRTC (§16).
 *
 * Nothing else can be asked here, so a request the registry was handed cannot become a way around the session.
 */
import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';

/** One request in the shape the tunnel switch and the WebRTC signaller already speak. */
export type IntroducerRequest = (path: string, init?: RequestInit) => Promise<Response>;

/** The routes an introducer request may name, by `<method> <path>`. */
const INTRODUCED_ROUTES: ReadonlySet<string> = new Set(['GET /v1/tunnel', 'PUT /v1/tunnel', 'POST /v1/webrtc/offer']);

/** Said when a request names a route that is not carrier control. */
const NOT_INTRODUCED = 'only carrier-control routes may be asked over an introducer';

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A client's call, as the response the daemon gave. An answer with a status is returned as it came (the daemon's own
 * sentence in `error`); a call that never got an answer rejects, as a failed request does.
 */
function introducerRequest(client: PluginClient): IntroducerRequest {
  return async (path, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const route = `${method} ${path}`;
    if (!INTRODUCED_ROUTES.has(route)) throw new Error(NOT_INTRODUCED);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    try {
      const answer = await client.call(route, {
        ...(body === undefined ? {} : { body }),
        ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      });
      return jsonResponse(answer, 200);
    } catch (error) {
      // A refusal is the daemon's answer; anything else (a carrier that ended, a deadline) is no answer at all.
      if (error instanceof DaemonCallError && error.carrier !== true) {
        return jsonResponse({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }
  };
}

/** The clients Connections' half holds, per paired daemon. */
export class IntroducerRegistry {
  readonly #clients = new Map<string, PluginClient>();

  /** Holds `client` for `daemonId` until the returned release; a later attach for the same daemon replaces it. */
  attach(daemonId: string, client: PluginClient): () => void {
    this.#clients.set(daemonId, client);
    return () => {
      if (this.#clients.get(daemonId) === client) this.#clients.delete(daemonId);
    };
  }

  /** The request for this daemon, or `undefined` while no half of Connections holds a client for it. */
  request(daemonId: string): IntroducerRequest | undefined {
    const client = this.#clients.get(daemonId);
    return client === undefined ? undefined : introducerRequest(client);
  }
}
