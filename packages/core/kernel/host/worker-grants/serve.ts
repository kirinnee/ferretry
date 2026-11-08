import type { FetchPort, RootHandle, RootName, RootsPort, WorkerRootGrant } from '../../contract/ports.ts';
import { MAX_ROOT_WINDOW_BYTES } from '../../contract/ports.ts';
import { z } from 'zod';
import { PermissionError } from '../permissions.ts';
import { RootError } from '../roots.ts';
import {
  MAX_GRANT_BODY_BYTES,
  MAX_GRANT_IN_FLIGHT,
  MAX_GRANT_REFUSALS_PER_WINDOW,
  GRANT_REFUSAL_WINDOW_MS,
  type WorkerFetchAnswer,
  type WorkerFetchInit,
  type WorkerGrantResponse,
  type WorkerGrantsData,
} from './wire.ts';

/** What one plugin's worker grants are made of: its OWN ports, already fenced and allowlisted by the manifest. */
export interface WorkerGrantSources {
  readonly plugin: string;
  readonly roots: RootsPort;
  /** The plugin's `kernel.fetch`: allowlist and no followed redirect. The worker goes through this very port. */
  readonly fetch: FetchPort;
  /** Whether the manifest declares any `permissions.network` at all (a wildcard is already dropped for it). */
  readonly declaresNetwork: boolean;
  /** The manifest's own host check (`hostPermitted`), asked with the hostname and the `host:port`. */
  readonly mayReach: (hostname: string, host: string) => boolean;
  /** Milliseconds from a monotonic clock, for the refusal window. Absent, the bound counts for the channel's whole life. */
  readonly nowMs?: () => number;
  /** Told once, with the plugin id, when a channel was closed for flooding the main thread with refused requests. */
  readonly flooded?: (plugin: string) => void;
}

export interface WorkerGrantRequestOptions {
  readonly roots?: readonly WorkerRootGrant[];
  readonly network?: true | readonly string[];
}

/** The grants of one worker, made at start: what goes into the thread, and how to end the service. */
export interface ServedGrants {
  readonly data: WorkerGrantsData;
  readonly transfer: readonly MessagePort[];
  close(): void;
}

const Path = z.string().max(4096);
const Limit = z.number().int().min(0).max(MAX_ROOT_WINDOW_BYTES);
const Window = z.object({ offset: z.number().int().min(0), length: Limit }).strict();
const RootCall = z.discriminatedUnion('op', [
  z.object({ op: z.literal('readText'), args: z.tuple([Path, Limit.optional()]) }),
  z.object({ op: z.literal('readBytes'), args: z.tuple([Path, z.union([Limit, Window]).optional()]) }),
  z.object({ op: z.literal('readTail'), args: z.tuple([Path, Limit]) }),
  z.object({ op: z.literal('list'), args: z.tuple([Path]) }),
  z.object({ op: z.literal('entries'), args: z.tuple([Path]) }),
  z.object({ op: z.literal('stat'), args: z.tuple([Path]) }),
  z.object({ op: z.literal('lstat'), args: z.tuple([Path]) }),
]);
const Envelope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root'), id: z.number().int().min(0), root: z.string().max(64) }).passthrough(),
  z.object({
    kind: z.literal('fetch'),
    id: z.number().int().min(0),
    url: z.string().max(8192),
    init: z
      .object({
        method: z.string().max(16).optional(),
        headers: z
          .array(z.tuple([z.string().max(256), z.string().max(16384)]))
          .max(128)
          .optional(),
        // The size is judged after the parse (`too_large`, below): structured clone has already copied the bytes
        // into the main heap, so the cap bounds what is FORWARDED, not what was received.
        body: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
      })
      .strict()
      .optional(),
  }),
  z.object({ kind: z.literal('cancel'), id: z.number().int().min(0) }),
]);

/** A refusal the worker is told: a fixed word, a fixed sentence. */
class Refused extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message);
  }
}

/** The request header a worker may not set: a shared front routes by it, so it could name a host the manifest never did. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set(['host']);
const bodyBytes = (body: string | Uint8Array): number =>
  typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;

const NO_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

function normalizeRoots(
  plugin: string,
  roots: RootsPort,
  grants: readonly WorkerRootGrant[],
): ReadonlyMap<string, RootHandle> {
  const handles = new Map<string, RootHandle>();
  for (const grant of grants) {
    const name = typeof grant === 'string' ? grant : (grant as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') throw new TypeError(`${plugin}: a worker root grant names a root`);
    if (handles.has(name)) throw new TypeError(`${plugin}: root ${name} is granted to the worker twice`);
    const scope = typeof grant === 'string' ? undefined : grant.scope;
    try {
      // The plugin's own port: an undeclared root (or one another plugin owns) refuses here, before a thread exists.
      handles.set(name, roots.root(name as RootName, scope));
    } catch (error) {
      if (error instanceof RootError)
        throw new PermissionError(
          `${plugin} may not grant a worker the ${name} root: its manifest does not declare it.`,
        );
      throw error;
    }
  }
  return handles;
}

/** `true`, or the subset of the manifest's hosts the worker is held to (each one the manifest already allows). */
function normalizeNetwork(
  sources: WorkerGrantSources,
  network: true | readonly string[] | undefined,
): ReadonlySet<string> | true | undefined {
  if (network === undefined) return undefined;
  if (network === true) {
    if (!sources.declaresNetwork)
      throw new PermissionError(`${sources.plugin} may not grant a worker the network: its manifest declares none.`);
    return true;
  }
  if (!Array.isArray(network) || network.length === 0)
    throw new TypeError(`${sources.plugin}: a worker network grant is true or a list of hosts`);
  const hosts = new Set<string>();
  for (const entry of network) {
    const wanted = typeof entry === 'string' ? entry.toLowerCase() : '';
    if (!HOST.test(wanted))
      throw new TypeError(`${sources.plugin}: ${String(entry)} is not a host a worker can be granted`);
    if (!sources.mayReach(wanted.split(':')[0] as string, wanted))
      throw new PermissionError(
        `${sources.plugin} may not grant a worker ${wanted}: its manifest does not declare it.`,
      );
    hosts.add(wanted);
  }
  return hosts;
}

/** Reads the whole body of a response up to the cap; past it the request is refused, never truncated silently. */
async function bounded(response: Response): Promise<Uint8Array> {
  if (response.body === null || NO_BODY_STATUS.has(response.status)) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_GRANT_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Refused('too_large', 'the response was larger than a worker may receive');
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * Makes one worker's grants: validates what was asked against THIS plugin's manifest (nothing a manifest does not
 * declare, ever), keeps the handles and the guard on the main thread, and answers the worker's requests over the
 * channel. A worker can name only what it was granted; every other request is a refusal, and a request that is not
 * one of the read shapes is dropped with a refusal too. Returns undefined when nothing was asked.
 */
export function serveWorkerGrants(
  sources: WorkerGrantSources,
  options: WorkerGrantRequestOptions,
): ServedGrants | undefined {
  const grants = options.roots ?? [];
  if (grants.length === 0 && options.network === undefined) return undefined;
  const handles = normalizeRoots(sources.plugin, sources.roots, grants);
  const network = normalizeNetwork(sources, options.network);
  const channel = new MessageChannel();
  const inFlight = new Map<number, AbortController>();
  let open = true;
  const close = (): void => {
    open = false;
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    channel.port1.close();
  };

  let windowStart = 0;
  let refusals = 0;
  /** Counts one refused request; past the bound in one window the channel ends, so a flood costs the main thread no more. */
  const tally = (): void => {
    const at = sources.nowMs?.() ?? 0;
    if (at - windowStart >= GRANT_REFUSAL_WINDOW_MS) {
      windowStart = at;
      refusals = 0;
    }
    refusals += 1;
    if (refusals > MAX_GRANT_REFUSALS_PER_WINDOW && open) {
      close();
      sources.flooded?.(sources.plugin);
    }
  };

  const reply = (response: WorkerGrantResponse): void => {
    if (open) channel.port1.postMessage(response);
  };
  const refuse = (id: number, refusal: string, message: string): undefined => {
    if (!open) return undefined;
    tally();
    reply({ id, ok: false, refusal, message });
    return undefined;
  };

  const rootCall = async (root: string, call: z.infer<typeof RootCall>): Promise<unknown> => {
    const handle = handles.get(root);
    if (handle === undefined) throw new Refused('not_granted', `the ${root} root was not granted to this worker`);
    // Paths are relative to the granted root. An absolute one would answer yes or no to a guess at where the root is.
    const asked = call.args[0];
    if (asked.startsWith('/') || asked.startsWith('\\') || asked.includes('\0'))
      throw new Refused('outside', `the path is not inside the ${root} root`);
    const resolved = handle.resolve(call.args[0]);
    if (!resolved.ok) throw new Refused(resolved.error, `the path is not inside the ${root} root`);
    const path = resolved.value;
    switch (call.op) {
      case 'readText':
        return await handle.readText(path, call.args[1] ?? MAX_ROOT_WINDOW_BYTES);
      case 'readBytes':
        return await handle.readBytes(path, call.args[1] ?? MAX_ROOT_WINDOW_BYTES);
      case 'readTail':
        return await handle.readTail(path, call.args[1]);
      case 'list':
        return await handle.list(path);
      case 'entries':
        return await handle.entries(path);
      case 'stat':
        return await handle.stat(path);
      case 'lstat':
        return await handle.lstat(path);
    }
  };

  const fetchCall = async (id: number, url: string, init: WorkerFetchInit | undefined): Promise<WorkerFetchAnswer> => {
    if (network === undefined) throw new Refused('not_granted', 'the network was not granted to this worker');
    if (network !== true) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Refused('malformed', 'the address is malformed');
      }
      // A grant that names a port is that port only; one that does not is the scheme's default port only.
      const reached =
        network.has(parsed.host.toLowerCase()) || (parsed.port === '' && network.has(parsed.hostname.toLowerCase()));
      if (!reached) throw new Refused('not_granted', `${parsed.hostname} was not granted to this worker`);
    }
    for (const [name] of init?.headers ?? [])
      if (FORBIDDEN_HEADERS.has(name.toLowerCase()))
        throw new Refused('malformed', 'a worker may not set that request header');
    if (init?.body !== undefined && bodyBytes(init.body) > MAX_GRANT_BODY_BYTES)
      throw new Refused('too_large', 'the request body was larger than a worker may send');
    const controller = new AbortController();
    inFlight.set(id, controller);
    try {
      const response = await sources.fetch.request(url, {
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(init?.headers === undefined ? {} : { headers: init.headers.map(([k, v]) => [k, v] as [string, string]) }),
        ...(init?.body === undefined ? {} : { body: init.body as BodyInit }),
        signal: controller.signal,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: await bounded(response),
      };
    } finally {
      inFlight.delete(id);
    }
  };

  const failure = (id: number, error: unknown, fetching: boolean): undefined => {
    if (error instanceof Refused) return refuse(id, error.refusal, error.message);
    // The fixed words only: a lower layer's message can carry a path or a URL's query.
    if (error instanceof RootError) return refuse(id, error.refusal, `the root refused: ${error.refusal}`);
    if (error instanceof PermissionError) return refuse(id, 'not_granted', error.message);
    return refuse(id, 'failed', fetching ? 'the request failed' : 'the read failed');
  };

  channel.port1.onmessage = (event: MessageEvent): undefined => {
    const raw = event.data as { id?: unknown } | null;
    const id = typeof raw?.id === 'number' && Number.isInteger(raw.id) && raw.id >= 0 ? raw.id : -1;
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) return refuse(id, 'malformed', 'the request is not one a worker may make');
    const request = parsed.data;
    if (request.kind === 'cancel') {
      inFlight.get(request.id)?.abort();
      return undefined;
    }
    if (inFlight.has(request.id) || inFlight.size >= MAX_GRANT_IN_FLIGHT)
      return refuse(request.id, 'busy', 'too many requests are waiting');
    if (request.kind === 'fetch') {
      void fetchCall(request.id, request.url, request.init).then(
        value => reply({ id: request.id, ok: true, value }),
        (error: unknown) => failure(request.id, error, true),
      );
      return undefined;
    }
    const call = RootCall.safeParse({ op: (raw as { op?: unknown }).op, args: (raw as { args?: unknown }).args });
    if (!call.success) return refuse(request.id, 'malformed', 'the request is not a read a worker may make');
    inFlight.set(request.id, new AbortController());
    void rootCall(request.root, call.data)
      .then(
        value => reply({ id: request.id, ok: true, value }),
        (error: unknown) => failure(request.id, error, false),
      )
      .finally(() => inFlight.delete(request.id));
    return undefined;
  };

  return {
    data: { port: channel.port2, roots: [...handles.keys()], network: network !== undefined },
    transfer: [channel.port2],
    close,
  };
}
