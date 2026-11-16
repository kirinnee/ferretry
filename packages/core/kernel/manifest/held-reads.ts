import type { PluginCallHeaders, PluginClient } from './implement.ts';

/**
 * A POLLED READ THAT COSTS NOTHING WHEN NOTHING CHANGED. The page keeps the body each read last answered, with the
 * `etag` the daemon named it by, and asks again with that tag in `If-None-Match`: a `304` is the held body, a `200`
 * replaces it. One mechanism for every polled route (the fleet list's `conditional`), so no poller keeps a validator
 * of its own.
 *
 * In memory and per client, which is per daemon: nothing outlives the page or reaches another daemon. Bounded and
 * least-recently-used, keyed by the exact route, parameters and query. A client without `conditional`, or an answer
 * that named no tag, is read whole every time, as before.
 */

/** How many reads keep their validator. A few open chats and boards each; past that the oldest reads whole. */
export const HELD_READ_LIMIT = 64;

/** The slice of the client a held read goes through. */
export type HeldReadClient = Pick<PluginClient, 'call' | 'conditional'>;

/** What one held read asks: the same `params`, `query` and allow-listed `headers` as a call. */
export interface HeldReadInit {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: PluginCallHeaders;
}

interface Held {
  readonly etag: string;
  readonly body: unknown;
}

const memories = new WeakMap<object, Map<string, Held>>();

const keyOf = (route: string, init: HeldReadInit): string =>
  JSON.stringify([
    route,
    Object.entries(init.params ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
    Object.entries(init.query ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
    Object.entries(init.headers ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
  ]);

/** The answer of one held read: the body (held or new) and whether the daemon said it is the one already held. */
export interface HeldRead<Body> {
  readonly body: Body;
  readonly unchanged: boolean;
}

/**
 * Reads `route` through `client`, sending the tag of the body this client last held for the same read. A `304` returns
 * that body (`unchanged`); a `200` replaces it. A `304` to a read that sent no tag has no body to stand for and throws.
 */
export async function heldRead<Body = unknown>(
  client: HeldReadClient,
  route: string,
  init: HeldReadInit = {},
): Promise<HeldRead<Body>> {
  const conditional = client.conditional;
  if (conditional === undefined)
    return {
      body: (await client.call(route, {
        ...(init.params === undefined ? {} : { params: init.params }),
        ...(init.query === undefined ? {} : { query: init.query }),
        ...(init.headers === undefined ? {} : { headers: init.headers }),
      })) as Body,
      unchanged: false,
    };
  let memory = memories.get(client);
  if (memory === undefined) {
    memory = new Map();
    memories.set(client, memory);
  }
  const key = keyOf(route, init);
  // Captured BEFORE the request, so a read that evicts it meanwhile cannot leave a `304` with nothing to stand for.
  const held = memory.get(key);
  const answer = await conditional.call(client, route, init.params ?? {}, {
    ...(held === undefined ? {} : { ifNoneMatch: held.etag }),
    ...(init.query === undefined ? {} : { query: init.query }),
    ...(init.headers === undefined ? {} : { headers: init.headers }),
  });
  if (answer.status === 304) {
    if (held === undefined) throw new Error('the daemon answered 304 Not Modified to a read that sent no validator');
    memory.delete(key);
    memory.set(key, held);
    return { body: held.body as Body, unchanged: true };
  }
  memory.delete(key);
  if (answer.etag !== undefined) {
    memory.set(key, { etag: answer.etag, body: answer.body });
    for (const oldest of memory.keys()) {
      if (memory.size <= HELD_READ_LIMIT) break;
      memory.delete(oldest);
    }
  }
  return { body: answer.body as Body, unchanged: false };
}
