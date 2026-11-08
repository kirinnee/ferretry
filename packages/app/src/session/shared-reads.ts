import type { TransportAnswer, TransportRequest } from '../client/transport.ts';

/**
 * ONE ANSWER FOR IDENTICAL READS ALREADY ON THEIR WAY (R519). Moved from today's `shared-reads.ts`, onto the
 * transport's request shape.
 *
 * Opening the app mounts every surface at once, and several of them ask one daemon the same question in the same
 * instant. Every one is a metered round trip that answers exactly what the identical request beside it is already
 * answering. So a read that is IDENTICAL — same method, same path, same query, same headers, no body — to one still in
 * flight joins it instead of being sent, and each caller gets its own copy of the one answer. Only a read that is in
 * flight is shared: nothing is cached, so nobody is ever handed an answer older than their own question. Anything with
 * a body, or any method but `GET` and `HEAD`, is passed straight through, because two identical writes are two writes.
 *
 * ONE TRANSPORT IS ONE DAEMON AND ONE DEVICE, so there is no scope to tell two machines' reads apart (today's `scope`
 * parameter): a read is only ever shared between callers of the same sealed sessions.
 *
 * EVERY CALLER KEEPS ITS OWN DEADLINE. A caller whose signal fires is answered with that signal's reason at once, and
 * leaves; the shared request itself is cancelled only when every caller has left, so one impatient caller cannot fail
 * the others, and an abandoned read does not keep the carrier busy.
 */

/** One request in, one answer out: the transport's own `request`. */
export type ReadSender = (request: TransportRequest) => Promise<TransportAnswer>;

interface Flight {
  readonly answer: Promise<TransportAnswer>;
  readonly controller: AbortController;
  /** Callers still waiting on this flight. */
  waiting: number;
}

const SHAREABLE = new Set(['GET', 'HEAD']);

/** Method, path, query and every header (names folded, sorted): two requests with this key are the same read. */
const readKey = (request: TransportRequest, method: string): string => {
  const sorted = (record: Readonly<Record<string, string>> | undefined, fold: boolean) =>
    Object.entries(record ?? {})
      .map(([name, value]) => [fold ? name.toLowerCase() : name, value] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify([method, request.path, sorted(request.query, false), sorted(request.headers, true)]);
};

/** Each caller's own answer: nobody may mutate what another caller reads. */
const copyOf = (answer: TransportAnswer): TransportAnswer => ({
  status: answer.status,
  headers: { ...answer.headers },
  body: structuredClone(answer.body),
});

/** Wraps `send` so an identical read already in flight is joined rather than sent again. */
export const sharingIdenticalReads = (send: ReadSender): ReadSender => {
  const flights = new Map<string, Flight>();

  const join = (flight: Flight, key: string, signal: AbortSignal | undefined): Promise<TransportAnswer> =>
    new Promise<TransportAnswer>((resolve, reject) => {
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
      flight.answer.then(
        answer => {
          if (settled) return;
          leave();
          resolve(copyOf(answer));
        },
        (reason: unknown) => {
          if (settled) return;
          leave();
          reject(reason);
        },
      );
    });

  return request => {
    const method = request.method.toUpperCase();
    if (!SHAREABLE.has(method) || request.body != null) return send(request);
    const key = readKey(request, method);
    let flight = flights.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      const created: Flight = { answer: send({ ...request, signal: controller.signal }), controller, waiting: 0 };
      const release = (): void => {
        if (flights.get(key) === created) flights.delete(key);
      };
      created.answer.then(release, release);
      flights.set(key, created);
      flight = created;
    }
    return join(flight, key, request.signal);
  };
};
