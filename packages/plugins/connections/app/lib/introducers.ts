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
 * A client's call, as the response the daemon gave. An answer comes back with the status the daemon gave it (a `202` held
 * for the owner stays a `202`; a refusal carries the daemon's own sentence in `error`); a call that never got an
 * answer rejects, as a failed request does.
 */
function introducerRequest(client: PluginClient): IntroducerRequest {
  return async (path, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const route = `${method} ${path}`;
    if (!INTRODUCED_ROUTES.has(route)) throw new Error(NOT_INTRODUCED);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    try {
      const call = {
        ...(body === undefined ? {} : { body }),
        ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      };
      // The daemon's own status goes back with its body: a `202` (a tunnel switch held for the owner) is not a `200`.
      // A client that can only hand over the body (`call`) has no status to keep, so its answer is a 200.
      if (client.callWithStatus === undefined) return jsonResponse(await client.call(route, call), 200);
      const answer = await client.callWithStatus(route, call);
      return jsonResponse(answer.body, answer.status);
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

  /**
   * ONE REAL READ OF THIS MACHINE: the reconnect loop's attempt. It is an ordinary `GET /v1/carriers` through the held
   * client, so it dials like any request. It says whether the machine ANSWERED — a 200 or the daemon's own refusal —
   * because a session that is already accepted carries the read with no new commit for the router to report, so the
   * answer itself is the one proof the machine is back. A call that never got an answer rejects, and with no client
   * held there is nothing to ask: neither is an answer.
   */
  async read(daemonId: string): Promise<boolean> {
    const client = this.#clients.get(daemonId);
    if (client === undefined) return false;
    try {
      await client.call('GET /v1/carriers');
    } catch (error) {
      if (error instanceof DaemonCallError && error.carrier !== true) return true;
      throw error;
    }
    return true;
  }

  /** The request for this daemon, or `undefined` while no half of Connections holds a client for it. */
  request(daemonId: string): IntroducerRequest | undefined {
    const client = this.#clients.get(daemonId);
    return client === undefined ? undefined : introducerRequest(client);
  }
}
