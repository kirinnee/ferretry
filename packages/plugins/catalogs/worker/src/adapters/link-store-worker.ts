/**
 * The hosted link store's Worker — `docs/relay-protocol.md` §17.
 *
 * THE COORDINATOR. It parses each public body with the wire schema, bounded before it is read, and
 * refuses a malformed one before any object is touched. It then walks the three objects in the order
 * the protocol names: control (is the store open, does it know this daemon), owner (the nonce, the
 * per-daemon quota), bundle (the link). The rules are theirs; the order and the rollback are here.
 *
 * NOT ROUTED. Nothing sends a request here yet: the hosted relay Worker has no binding for it (slice
 * 3f-3), so a deployed store is reachable by its own address only.
 *
 * NOTHING IS LOGGED but a fixed sentence: never a body, a token, a verifier, a bundle id, a daemon or
 * an address. The IP the per-IP windows need goes to the control object in a request body and nowhere else.
 */
import { LinkBundleIdSchema } from '../../../contract/wire/index.ts';
import type { z } from 'zod';
import {
  DEFAULT_LINK_STORE_LIMITS,
  fromBase64UrlFixed,
  LINK_ENVELOPE_MAX_BYTES,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_CHALLENGE_SECONDS,
  LINK_STORE_OPERATOR_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  LINK_STORE_VERSION,
  LINK_UPLOAD_METADATA_MAX_BYTES,
  type LinkStoreRefusalCode,
  type LinkStoreRequestBody,
  LinkDeleteRequestSchema,
  LinkFetchRequestSchema,
  LinkStatusRequestSchema,
  LinkStatusSchema,
  LinkStoreChallengeRequestSchema,
  LinkStoreOperatorUpdateSchema,
  type LinkStoreLimits,
  type LinkStatus,
  decodeLinkUploadBody,
  linkStoreRefusalBody,
  linkUploadSignedBody,
  NONCE_BYTES,
  parseRelayTenancy,
  type RelayTenancy,
  servesDaemon,
  type SignedLinkStoreRequest,
  toBase64Url,
  verifyLinkStoreRequest,
} from '../lib/index.ts';
import type { HostedRelayControlNamespace } from './durable-storage.ts';
import {
  ControlReplies,
  LINK_BUNDLE_HEADERS,
  LINK_STORE_CONTROL_OBJECT_NAME,
  LinkBundleDurableObject,
  LinkOwnerDurableObject,
  LinkStoreControlDurableObject,
  type LinkStoreObjectEnvironment,
  type LinkStoreRuntime,
  linkBundleObjectName,
  linkOwnerObjectName,
  linkStoreRuntime,
  objectFetch,
  OwnerReplies,
  parsedReply,
  refusalResponse,
} from './link-store-objects.ts';
import { operatorRefusal } from './operator-auth.ts';
import { WebCryptoSessionCrypto } from '../kernel-wire/index.ts';

export { LinkBundleDurableObject, LinkOwnerDurableObject, LinkStoreControlDurableObject };

export interface LinkStoreEnvironment extends LinkStoreObjectEnvironment {
  readonly LINK_BUNDLE?: HostedRelayControlNamespace;
  /** `hosted` or `self-hosted`. Anything else, including nothing, serves nobody. */
  readonly LINK_STORE_MODE?: string;
  /** Self-hosted only: the daemons this deployment carries. Empty carries nobody. */
  readonly LINK_STORE_DAEMON_IDS?: string;
  readonly LINK_STORE_OPERATOR_TOKEN?: string;
}

/** A signed JSON body is a few hundred bytes (a status names 64 ids); nothing real is larger. */
export const LINK_JSON_MAX_BYTES = 16 * 1024;
const UPLOAD_MAX_BYTES = LINK_UPLOAD_METADATA_MAX_BYTES + 4 + LINK_ENVELOPE_MAX_BYTES;

const PUBLIC_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store, max-age=0',
} as const;
const LINK_ROUTE = /^\/v1\/links\/([^/]+)(?:\/(peek|fetch))?$/u;
const crypto = new WebCryptoSessionCrypto();

type Operation = 'upload' | 'delete' | 'status';

interface Context {
  readonly request: Request;
  readonly environment: LinkStoreEnvironment;
  readonly runtime: LinkStoreRuntime;
  readonly tenancy: RelayTenancy | null;
}

const exposed = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.delete('Set-Cookie');
  for (const [name, value] of Object.entries(PUBLIC_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
};

const jsonBody = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

function wrongMethod(allow: string): Response {
  return new Response(linkStoreRefusalBody('link_bad_request'), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: allow },
  });
}

/** The caller's address, or one shared bucket's name. It reaches the control object's memory and nothing else. */
const addressOf = (request: Request): string => {
  const supplied = request.headers.get('CF-Connecting-IP')?.trim() ?? '';
  return supplied === '' || supplied.length > 64 ? 'unknown' : supplied;
};

/** The body's bytes, or null when it is larger than `max` — decided while reading, so a lie in Content-Length gains nothing. */
async function readBounded(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function boundedJson<T extends z.ZodType>(request: Request, schema: T): Promise<Parsed<z.infer<T>>> {
  const bytes = await readBounded(request, LINK_JSON_MAX_BYTES);
  if (bytes === null) return { ok: false };
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A signed JSON body too big or unreadable is the one 400: "export it as a file" is advice for an upload, not for a status request. */
const unparsed = (): Response => refusalResponse('link_bad_request');

/** One request to an object and its answer checked against the shape that object promises, or null. */
async function ask<T extends z.ZodType>(
  namespace: HostedRelayControlNamespace | undefined,
  name: string,
  route: string,
  body: unknown,
  schema: T,
): Promise<z.infer<T> | null> {
  try {
    return await parsedReply(await objectFetch(namespace, name, route, { body: JSON.stringify(body) }), schema);
  } catch {
    return null;
  }
}

const control = <T extends z.ZodType>(context: Context, route: string, body: unknown, schema: T) =>
  ask(context.environment.LINK_STORE_CONTROL, LINK_STORE_CONTROL_OBJECT_NAME, route, body, schema);

const unavailable = (): Response => refusalResponse('link_store_unavailable');

const refusedBy = (answer: { readonly ok: false; readonly code: LinkStoreRefusalCode }): Response =>
  refusalResponse(answer.code);

// ── Entry ────────────────────────────────────────────────────────────────────────────────────────

export async function linkStoreFetch(
  request: Request,
  environment: LinkStoreEnvironment,
  runtime: LinkStoreRuntime = linkStoreRuntime,
): Promise<Response> {
  const url = new URL(request.url);
  const mode = environment.LINK_STORE_MODE;
  if (mode !== 'hosted' && mode !== 'self-hosted') {
    runtime.log('link store: LINK_STORE_MODE is not hosted or self-hosted, so it serves nobody');
    return exposed(unavailable());
  }
  const context: Context = {
    request,
    environment,
    runtime,
    tenancy: mode === 'self-hosted' ? parseRelayTenancy(environment.LINK_STORE_DAEMON_IDS) : null,
  };
  try {
    if (url.pathname === LINK_STORE_OPERATOR_PATH) return await operator(context);
    return exposed(await publicRoute(context, url.pathname));
  } catch {
    runtime.log('link store: a request failed unexpectedly');
    return exposed(unavailable());
  }
}

async function publicRoute(context: Context, pathname: string): Promise<Response> {
  const { request } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      },
    });
  }
  switch (pathname) {
    case LINK_STORE_SERVICE_PATH:
      return request.method === 'GET' ? advertisement(context) : wrongMethod('GET, OPTIONS');
    case LINK_STORE_CHALLENGE_PATH:
      return request.method === 'POST' ? challenge(context) : wrongMethod('POST, OPTIONS');
    case LINK_STORE_STATUS_PATH:
      return request.method === 'POST' ? status(context) : wrongMethod('POST, OPTIONS');
    default:
      return linkRoute(context, pathname);
  }
}

async function linkRoute(context: Context, pathname: string): Promise<Response> {
  const match = LINK_ROUTE.exec(pathname);
  const bundleId = LinkBundleIdSchema.safeParse(match?.[1]);
  if (match === null || !bundleId.success) return refusalResponse('link_unknown');
  const action = match[2];
  const { method } = context.request;
  if (action === undefined) {
    if (method === 'PUT') return upload(context, bundleId.data);
    if (method === 'DELETE') return remove(context, bundleId.data);
    return wrongMethod('PUT, DELETE, OPTIONS');
  }
  return method === 'POST' ? open(context, bundleId.data, action as 'peek' | 'fetch') : wrongMethod('POST, OPTIONS');
}

// ── Discovery and challenge ──────────────────────────────────────────────────────────────────────

async function advertisement(context: Context): Promise<Response> {
  const answered = await control(context, '/service', {}, ControlReplies.service);
  return jsonBody(
    answered ?? {
      version: LINK_STORE_VERSION,
      available: false,
      maxEnvelopeBytes: LINK_ENVELOPE_MAX_BYTES,
      maxLiveLinks: DEFAULT_LINK_STORE_LIMITS.perDaemon.liveLinks,
    },
  );
}

async function challenge(context: Context): Promise<Response> {
  const parsed = await boundedJson(context.request, LinkStoreChallengeRequestSchema);
  if (!parsed.ok) return unparsed();
  const { daemonId } = parsed.value;
  if (context.tenancy !== null && !servesDaemon(context.tenancy, daemonId)) return refusalResponse('link_unknown');
  const gate = await control(
    context,
    '/challenge',
    { daemonId, ip: addressOf(context.request) },
    ControlReplies.challenge,
  );
  if (gate === null) return unavailable();
  if (!gate.ok) return refusedBy(gate);
  const nonce = toBase64Url(crypto.randomBytes(NONCE_BYTES));
  const issued = await ask(
    context.environment.LINK_OWNER,
    linkOwnerObjectName(daemonId),
    '/challenge',
    { nonce, limits: gate.limits },
    OwnerReplies.challenge,
  );
  if (issued === null) return unavailable();
  if (!issued.ok) return refusedBy(issued);
  return jsonBody({ version: LINK_STORE_VERSION, nonce, deadlineSeconds: LINK_STORE_CHALLENGE_SECONDS });
}

// ── Signed requests ──────────────────────────────────────────────────────────────────────────────

/**
 * The common front of upload, delete and status. Returns the refusal to send, or the limits in force.
 * The nonce is spent here, before the signature is judged: a guess costs the guesser its nonce.
 */
async function admit(
  context: Context,
  signed: SignedLinkStoreRequest,
  op: Operation,
  body: LinkStoreRequestBody,
): Promise<Response | LinkStoreLimits> {
  if (context.tenancy !== null && !servesDaemon(context.tenancy, signed.daemonId))
    return refusalResponse('link_unknown');
  const admitted = await control(context, '/admit', { daemonId: signed.daemonId, op }, ControlReplies.admit);
  if (admitted === null) return unavailable();
  if (!admitted.ok) return refusedBy(admitted);
  const spent = await ask(
    context.environment.LINK_OWNER,
    linkOwnerObjectName(signed.daemonId),
    '/spend',
    { nonce: signed.nonce },
    OwnerReplies.spend,
  );
  if (spent === null) return unavailable();
  if (!spent.spent) return refusalResponse('link_challenge_expired');
  const nonce = fromBase64UrlFixed(signed.nonce, NONCE_BYTES) ?? new Uint8Array(0);
  const verdict = await verifyLinkStoreRequest(
    crypto,
    { daemonId: signed.daemonId, host: new URL(context.request.url).host, nonce, body },
    signed,
  );
  return verdict.ok ? admitted.limits : refusalResponse('link_claim_rejected');
}

const bundleHeaders = (
  bundleId: string,
  limits: LinkStoreLimits,
  extra: { readonly daemon?: string; readonly verifier?: string },
): Record<string, string> => ({
  [LINK_BUNDLE_HEADERS.bundle]: bundleId,
  [LINK_BUNDLE_HEADERS.limits]: JSON.stringify(limits.perLink),
  ...(extra.daemon === undefined ? {} : { [LINK_BUNDLE_HEADERS.daemon]: extra.daemon }),
  ...(extra.verifier === undefined ? {} : { [LINK_BUNDLE_HEADERS.verifier]: extra.verifier }),
});

const toBundle = (
  context: Context,
  bundleId: string,
  route: string,
  headers: Record<string, string>,
  body?: Uint8Array,
): Promise<Response> =>
  objectFetch(context.environment.LINK_BUNDLE, linkBundleObjectName(bundleId), route, {
    headers,
    ...(body === undefined ? {} : { body }),
  });

async function upload(context: Context, bundleId: string): Promise<Response> {
  const bytes = await readBounded(context.request, UPLOAD_MAX_BYTES);
  if (bytes === null) return refusalResponse('link_too_big');
  const frame = await decodeLinkUploadBody(crypto, bytes);
  if (!frame.ok) return refusalResponse(frame.reason === 'too_big' ? 'link_too_big' : 'link_bad_request');
  const { metadata } = frame;
  const admitted = await admit(context, metadata, 'upload', linkUploadSignedBody(bundleId, metadata));
  if (admitted instanceof Response) return admitted;
  const owner = metadata.daemonId;
  const until = Date.parse(metadata.notAfter);
  const create = metadata.action === 'create';
  const reservation = { bundleId, bytes: metadata.envelopeBytes, until, create };

  const global = await control(context, '/reserve', { owner, ...reservation }, ControlReplies.reserve);
  if (global === null) return unavailable();
  if (!global.ok) return refusedBy(global);
  const rollBackControl = () =>
    control(context, '/rollback', { bundleId, previous: global.previous, day: global.day }, ControlReplies.rollback);

  const local = await ask(
    context.environment.LINK_OWNER,
    linkOwnerObjectName(owner),
    '/reserve',
    { reservation, limits: global.limits },
    OwnerReplies.reserve,
  );
  if (local === null || !local.ok) {
    await rollBackControl();
    return local === null ? unavailable() : refusedBy(local);
  }
  const rollBack = async () => {
    await ask(
      context.environment.LINK_OWNER,
      linkOwnerObjectName(owner),
      '/undo',
      { undo: local.undo },
      OwnerReplies.done,
    );
    await rollBackControl();
  };

  let stored: Response;
  try {
    stored = await toBundle(
      context,
      bundleId,
      '/upload',
      bundleHeaders(bundleId, global.limits, { daemon: owner }),
      bytes,
    );
  } catch {
    await rollBack();
    return unavailable();
  }
  if (stored.status !== 200) await rollBack();
  return stored;
}

async function remove(context: Context, bundleId: string): Promise<Response> {
  const parsed = await boundedJson(context.request, LinkDeleteRequestSchema);
  if (!parsed.ok) return unparsed();
  const signed = parsed.value;
  const admitted = await admit(context, signed, 'delete', { request: 'delete', bundleId });
  if (admitted instanceof Response) return admitted;
  const owns = await control(
    context,
    '/owned',
    { owner: signed.daemonId, bundleIds: [bundleId] },
    ControlReplies.owned,
  );
  if (owns === null) return unavailable();
  if (!owns.ok) return refusedBy(owns);
  if (!owns.owned.includes(bundleId)) return refusalResponse('link_unknown');
  try {
    return await toBundle(context, bundleId, '/delete', bundleHeaders(bundleId, admitted, { daemon: signed.daemonId }));
  } catch {
    return unavailable();
  }
}

async function status(context: Context): Promise<Response> {
  const parsed = await boundedJson(context.request, LinkStatusRequestSchema);
  if (!parsed.ok) return unparsed();
  const signed = parsed.value;
  const ids = [...new Set(signed.bundleIds)];
  const admitted = await admit(context, signed, 'status', { request: 'status', bundleIds: signed.bundleIds });
  if (admitted instanceof Response) return admitted;
  const owns = await control(context, '/owned', { owner: signed.daemonId, bundleIds: ids }, ControlReplies.owned);
  if (owns === null) return unavailable();
  if (!owns.ok) return refusedBy(owns);
  const owned = new Set(owns.owned);
  const links = await Promise.all(
    ids.map(async (bundleId): Promise<LinkStatus['links'][number]> => {
      const unknown = { bundleId, state: 'unknown' } as const;
      if (!owned.has(bundleId)) return unknown;
      try {
        const answer = await toBundle(
          context,
          bundleId,
          '/status',
          bundleHeaders(bundleId, admitted, { daemon: signed.daemonId }),
        );
        return (await parsedReply(answer, LinkStatusSchema))?.links[0] ?? unknown;
      } catch {
        return unknown;
      }
    }),
  );
  return jsonBody({ version: LINK_STORE_VERSION, links });
}

// ── Peek and fetch ───────────────────────────────────────────────────────────────────────────────

/**
 * A body that is not `{ token }` is the same 410 as a wrong token: whoever cannot produce a token holds
 * none, and a 400 here would be a second answer a prober could tell apart from the first.
 */
async function open(context: Context, bundleId: string, action: 'peek' | 'fetch'): Promise<Response> {
  const parsed = await boundedJson(context.request, LinkFetchRequestSchema);
  if (!parsed.ok) return refusalResponse('link_gone');
  const token = fromBase64UrlFixed(parsed.value.token, 32);
  if (token === null) return refusalResponse('link_gone');
  const verdict = await control(
    context,
    '/open',
    { type: action, bundleId, ip: addressOf(context.request) },
    ControlReplies.open,
  );
  if (verdict === null) return unavailable();
  if (!verdict.ok) return refusedBy(verdict);
  if (verdict.verdict === 'gone') return refusalResponse('link_gone');
  const limits: LinkStoreLimits = {
    ...DEFAULT_LINK_STORE_LIMITS,
    perLink: verdict.perLink ?? DEFAULT_LINK_STORE_LIMITS.perLink,
  };
  const verifier = toBase64Url(await crypto.sha256(token));
  const answer = await toBundle(context, bundleId, `/${action}`, bundleHeaders(bundleId, limits, { verifier }));
  if (action === 'fetch' && answer.status === 200) {
    await control(context, '/fetched', {}, ControlReplies.fetched);
  }
  return answer;
}

// ── Operator ─────────────────────────────────────────────────────────────────────────────────────

const operatorJson = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' },
  });

async function operator(context: Context): Promise<Response> {
  const { request, environment } = context;
  const refused = operatorRefusal(request, environment.LINK_STORE_OPERATOR_TOKEN);
  if (refused !== null) return refused;
  if (request.method !== 'GET' && request.method !== 'PUT') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, PUT', 'Cache-Control': 'no-store' },
    });
  }
  let body: string | undefined;
  if (request.method === 'PUT') {
    const parsed = await boundedJson(request, LinkStoreOperatorUpdateSchema);
    if (!parsed.ok) {
      return operatorJson(
        { error: 'expected { "available"?: boolean, "serving"?: boolean, "limits"?: every limit, whole }' },
        400,
      );
    }
    body = JSON.stringify(parsed.value);
  }
  try {
    const answer = await objectFetch(environment.LINK_STORE_CONTROL, LINK_STORE_CONTROL_OBJECT_NAME, '/operator', {
      method: request.method,
      ...(body === undefined ? {} : { body }),
    });
    const view = await parsedReply(answer, ControlReplies.operator);
    return view === null ? operatorJson({ error: 'the link store could not be reached' }, 503) : operatorJson(view);
  } catch {
    return operatorJson({ error: 'the link store could not be reached' }, 503);
  }
}

export default {
  fetch: (request: Request, environment: LinkStoreEnvironment): Promise<Response> =>
    linkStoreFetch(request, environment),
};
