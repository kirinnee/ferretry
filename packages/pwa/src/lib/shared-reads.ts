/**
 * ONE ANSWER FOR IDENTICAL READS ALREADY ON THEIR WAY.
 *
 * Opening the app mounts every surface at once, and several of them ask one daemon the same question
 * in the same instant: the usage meter and the machine list both read `/v1/usage`, the runtime
 * notice and the account picker both read `/v1/fleet/runtimes`, the update notices read
 * `/v1/daemon/update` from two places. Measured over the relay (`scripts/local/bench-app-load.ts`),
 * a two-machine open sent each of those four times. Every one is a metered round trip that answers
 * exactly what the identical request beside it is already answering.
 *
 * So a read that is IDENTICAL — same method, same URL, same headers, no body — to one still in flight
 * joins it instead of being sent, and each caller gets its own copy of the one response. Only a read
 * that is in flight is shared: nothing is cached, so nobody is ever handed an answer older than their
 * own question. Anything with a body, or any method but `GET` and `HEAD`, is passed straight through,
 * because two identical writes are two writes.
 *
 * EVERY CALLER KEEPS ITS OWN DEADLINE. The typed client gives every request an abort signal (its own
 * deadline, and the caller's). A caller whose signal fires is answered with that signal's reason at
 * once, and leaves; the shared request itself is cancelled only when every caller has left, so one
 * impatient caller cannot fail the others, and an abandoned read does not keep the carrier busy.
 */

/** The transport shape this wraps: one request in, one response out (the carrier's `fetch` shape). */
export type ReadSender = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Flight {
  readonly response: Promise<Response>;
  readonly controller: AbortController;
  /** Callers still waiting on this flight. */
  waiting: number;
}

const SHAREABLE = new Set(['GET', 'HEAD']);

/**
 * Method, URL, every header (case-folded and sorted) and the caller's scope: two requests with this
 * key are the same read.
 */
const readKey = (scope: string, method: string, url: string, headers: HeadersInit | undefined): string => {
  // Names folded here rather than trusted to `Headers`: not every implementation folds them.
  const entries = [...new Headers(headers).entries()]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return JSON.stringify([scope, method, url, entries]);
};

/**
 * Wraps `send` so an identical read already in flight is joined rather than sent again.
 *
 * `scope` names what else makes two requests different reads although their URL and headers agree —
 * the daemon a request is bound to, where two paired machines announce one address. Absent: none.
 */
export const sharingIdenticalReads = (
  send: ReadSender,
  scope: (init: RequestInit) => string = () => '',
): ReadSender => {
  const flights = new Map<string, Flight>();

  const join = (flight: Flight, key: string, signal: AbortSignal | null | undefined): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      let settled = false;
      flight.waiting += 1;
      const leave = (): void => {
        settled = true;
        flight.waiting -= 1;
        signal?.removeEventListener('abort', abandon);
      };
      function abandon(): void {
        if (settled) return;
        leave();
        reject(signal?.reason);
        if (flight.waiting > 0) return;
        // Nobody is left to read it: free the slot first, so a later identical read starts afresh.
        if (flights.get(key) === flight) flights.delete(key);
        flight.controller.abort(signal?.reason);
      }
      if (signal?.aborted === true) {
        abandon();
        return;
      }
      signal?.addEventListener('abort', abandon, { once: true });
      flight.response.then(
        response => {
          if (settled) return;
          leave();
          resolve(response.clone());
        },
        (reason: unknown) => {
          if (settled) return;
          leave();
          reject(reason);
        },
      );
    });

  return (input, init = {}) => {
    // A `Request` carries its own method, headers and body: it is passed through rather than read apart.
    if (typeof input !== 'string' && !(input instanceof URL)) return send(input, init);
    const url = input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    if (!SHAREABLE.has(method) || init.body != null) return send(input, init);
    const key = readKey(scope(init), method, url, init.headers);
    let flight = flights.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      const created: Flight = { response: send(url, { ...init, signal: controller.signal }), controller, waiting: 0 };
      const release = (): void => {
        if (flights.get(key) === created) flights.delete(key);
      };
      created.response.then(release, release);
      flights.set(key, created);
      flight = created;
    }
    return join(flight, key, init.signal);
  };
};
