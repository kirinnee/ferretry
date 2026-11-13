/**
 * The link store's three Durable Objects — `docs/relay-protocol.md` §17.
 *
 * All SQLite-backed, all thin: each serialises its requests, adapts storage to the pure functions in
 * `lib/link-store-bundle.ts` and `lib/link-store-shards.ts`, and keeps its alarm. The rules are not here.
 *
 * - `LinkBundleDurableObject` — ONE link: its row, its envelope in chunks of at most 512 KiB, its windows.
 * - `LinkOwnerDurableObject` — ONE daemon: nonces, challenge window, quota leases.
 * - `LinkStoreControlDurableObject` — ONE per deployment: the operator's switches and limits, the global
 *   counters, the registry of every bundle id ever created (so an id never created costs no object) and
 *   the per-IP windows, which live in memory only.
 *
 * WHY EACH SERIALISES. A Durable Object is single-threaded, but every storage read is an `await` that lets
 * the next request in. Two fetches of a one-time link would each read it live. Requests are therefore
 * chained, as the tunnel control object chains its own, and the write that spends a link is awaited before
 * the response that carries its bytes leaves.
 *
 * NOTHING IS LOGGED but a fixed sentence and an error class: never a body, a token, a verifier, a bundle
 * id, a daemon or an address.
 */
import { LinkBundleIdSchema } from '../../../contract/wire/index.ts';
import { z } from 'zod';
import {
  BundleDocSchema,
  type BundleDoc,
  type BundleEvent,
  type BundleStep,
  type ControlState,
  ControlStateSchema,
  controlChallengeGate,
  controlOpenVerdict,
  controlReserveGate,
  countedToday,
  DEFAULT_LINK_STORE_LIMITS,
  dayOf,
  dueKey,
  EMPTY_CONTROL_STATE,
  EMPTY_OWNER_SHARD,
  joinChunks,
  LINK_ENVELOPE_MAX_BYTES,
  LINK_STORE_VERSION,
  type LinkRecord,
  LinkRecordSchema,
  type LinkStoreConfig,
  LinkStoreConfigSchema,
  type LinkStoreLimits,
  LinkStoreLimitsSchema,
  LinkStoreOperatorUpdateSchema,
  LinkStoreRefusalCodeSchema,
  type LinkStoreRefusalCode,
  linkRecordDueAt,
  linkStoreRefusalBody,
  LINK_STORE_REFUSAL_DETAIL,
  LINK_KIND_HEADER,
  LINK_SEQUENCE_HEADER,
  chunkEnvelope,
  decodeLinkUploadBody,
  ownerAlarmAt,
  ownerChallenge,
  ownerIdle,
  OwnerShardSchema,
  ownerRelease,
  ownerReserve,
  ownerSpendNonce,
  ownerUndo,
  parseDueKey,
  PerLinkLimitsSchema,
  reduceBundle,
  replaceRecordTotals,
  SlidingWindows,
  sweepOwner,
  type OwnerShard,
} from '../lib/index.ts';
import { WebCryptoSessionCrypto } from '../kernel-wire/index.ts';
import type {
  HostedRelayControlNamespace,
  HostedRelayControlStorage,
  HostedRelayControlStorageTransaction,
} from './durable-storage.ts';

export const LINK_STORE_CONTROL_OBJECT_NAME = 'ferretry-link-store-control/1' as const;
export const linkBundleObjectName = (bundleId: string): string => `ferretry-link/1:${bundleId}`;
export const linkOwnerObjectName = (daemonId: string): string => `ferretry-link-owner/1:${daemonId}`;

/** The most keys a per-IP or per-id window holds before it forgets the oldest. A memory bound, not a rate. */
export const LINK_WINDOW_MAX_KEYS = 4096;
/** How many due entries one control alarm settles before it asks to be woken again. */
const DUE_BATCH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LinkObjectStorage extends HostedRelayControlStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface LinkObjectState {
  readonly storage: LinkObjectStorage;
}

export interface LinkStoreObjectEnvironment {
  readonly LINK_OWNER?: HostedRelayControlNamespace;
  readonly LINK_STORE_CONTROL?: HostedRelayControlNamespace;
}

export interface LinkStoreRuntime {
  now(): number;
  log(message: string): void;
}

export const linkStoreRuntime: LinkStoreRuntime = { now: () => Date.now(), log: message => console.error(message) };

/** Raised when storage holds something this module did not write. The caller answers 503 and says so once. */
class LinkStoreStateDamagedError extends Error {
  constructor(what: string) {
    super(`link store state is damaged: ${what}`);
    this.name = 'LinkStoreStateDamagedError';
  }
}

// ── Talking between objects ──────────────────────────────────────────────────────────────────────

const INTERNAL_ORIGIN = 'https://link-store.invalid';

export const LINK_BUNDLE_HEADERS = {
  bundle: 'X-Link-Bundle',
  limits: 'X-Link-Limits',
  daemon: 'X-Link-Daemon',
  verifier: 'X-Link-Verifier',
} as const;

/**
 * One request to a named object. Rejects when the binding is missing, which callers treat as unavailable.
 * Always a rejection, never a synchronous throw: the bundle object's best-effort release hands two of
 * these to `allSettled`, and a throw while building the array would skip it and fail a fetch whose link
 * is already spent.
 */
/** A Request body must be an own ArrayBuffer, not any view over a shared one. */
function ownBuffer(body: string | Uint8Array): string | ArrayBuffer {
  if (typeof body === 'string') return body;
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

export async function objectFetch(
  namespace: HostedRelayControlNamespace | undefined,
  name: string,
  route: string,
  init: {
    readonly method?: string;
    readonly body?: string | Uint8Array;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<Response> {
  if (namespace === undefined) throw new LinkStoreStateDamagedError('a binding is missing');
  return await namespace.get(namespace.idFromName(name)).fetch(
    new Request(`${INTERNAL_ORIGIN}${route}`, {
      method: init.method ?? 'POST',
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: ownBuffer(init.body) }),
    }),
  );
}

const Refused = z.strictObject({ ok: z.literal(false), code: LinkStoreRefusalCodeSchema });
/** An object's answer to a gate: either `{ ok: true, …shape }` or the refusal the caller passes on. */
const reply = <T extends z.ZodRawShape>(shape: T) =>
  z.union([z.strictObject({ ok: z.literal(true), ...shape }), Refused]);

export const ControlReplies = {
  admit: reply({ limits: LinkStoreLimitsSchema }),
  challenge: reply({ limits: LinkStoreLimitsSchema }),
  reserve: reply({ limits: LinkStoreLimitsSchema, previous: LinkRecordSchema.nullable(), day: z.number() }),
  rollback: reply({}),
  release: reply({}),
  fetched: reply({}),
  open: reply({ verdict: z.enum(['proceed', 'gone']), perLink: PerLinkLimitsSchema.optional() }),
  owned: reply({ owned: z.array(LinkBundleIdSchema) }),
  operator: z.strictObject({
    available: z.boolean(),
    serving: z.boolean(),
    limits: LinkStoreLimitsSchema,
    metrics: z.strictObject({
      owners: z.number(),
      liveLinks: z.number(),
      storedBytes: z.number(),
      tombstones: z.number(),
    }),
  }),
  service: z.strictObject({
    version: z.literal(LINK_STORE_VERSION),
    available: z.boolean(),
    maxEnvelopeBytes: z.number().int().min(1),
    maxLiveLinks: z.number().int().min(1),
  }),
} as const;

export const OwnerReplies = {
  challenge: reply({}),
  spend: z.strictObject({ spent: z.boolean() }),
  reserve: reply({
    undo: z.strictObject({
      bundleId: z.string(),
      previous: z.strictObject({ bytes: z.number(), until: z.number() }).nullable(),
      day: z.number(),
    }),
  }),
  done: z.strictObject({ ok: z.literal(true) }),
} as const;

/** The parsed JSON of an object's answer, or null when it was not what the schema says. */
export async function parsedReply<T extends z.ZodType>(response: Response, schema: T): Promise<z.infer<T> | null> {
  try {
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function bodyOf<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) throw new LinkStoreStateDamagedError('an internal request');
  return parsed.data;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' },
  });

const refused = (code: LinkStoreRefusalCode): Response => json({ ok: false, code });

/** The refusal a public caller receives, spelled one way so equal refusals are equal bytes. */
export function refusalResponse(code: LinkStoreRefusalCode): Response {
  return new Response(linkStoreRefusalBody(code), {
    status: LINK_STORE_REFUSAL_DETAIL[code].status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' },
  });
}

abstract class SerialisedObject {
  private queue: Promise<unknown> = Promise.resolve();

  protected serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  protected abstract failure(error: unknown): Response;

  protected guarded(request: Request, route: (request: Request) => Promise<Response>): Promise<Response> {
    return this.serialised(async () => {
      try {
        return await route(request);
      } catch (error) {
        return this.failure(error);
      }
    });
  }
}

const damageNote = (error: unknown): string =>
  error instanceof LinkStoreStateDamagedError ? 'its stored state is damaged' : 'it failed unexpectedly';

// ── Bundle object ────────────────────────────────────────────────────────────────────────────────

const DOC_KEY = 'doc';
const ID_KEY = 'bundle';
const chunkKey = (index: number): string => `chunk:${index}`;

const FrameHeaders = z.strictObject({
  bundle: LinkBundleIdSchema,
  limits: z.string().transform((text, ctx) => {
    try {
      return PerLinkLimitsSchema.parse(JSON.parse(text));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'limits' });
      return z.NEVER;
    }
  }),
  daemon: z.string().optional(),
  verifier: z.string().optional(),
});

export class LinkBundleDurableObject extends SerialisedObject {
  constructor(
    private readonly objectState: LinkObjectState,
    private readonly environment: LinkStoreObjectEnvironment = {},
    private readonly runtime: LinkStoreRuntime = linkStoreRuntime,
  ) {
    super();
  }

  fetch(request: Request): Promise<Response> {
    return this.guarded(request, incoming => this.route(incoming));
  }

  /** The link's end, then its tombstone's purge. */
  alarm(): Promise<void> {
    return this.serialised(async () => {
      try {
        const bundleId = await this.objectState.storage.get<string>(ID_KEY);
        if (bundleId === undefined) return this.objectState.storage.deleteAlarm();
        await this.run(bundleId, { type: 'alarm', now: this.runtime.now() }, DEFAULT_LINK_STORE_LIMITS);
      } catch (error) {
        this.runtime.log(`link store: a bundle object's alarm failed because ${damageNote(error)}`);
        await this.objectState.storage.setAlarm(this.runtime.now() + 60_000);
      }
    });
  }

  protected failure(error: unknown): Response {
    this.runtime.log(`link store: a bundle object failed because ${damageNote(error)}`);
    return refusalResponse('link_store_unavailable');
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const headers = FrameHeaders.parse({
      bundle: request.headers.get(LINK_BUNDLE_HEADERS.bundle),
      limits: request.headers.get(LINK_BUNDLE_HEADERS.limits),
      ...optional('daemon', request.headers.get(LINK_BUNDLE_HEADERS.daemon)),
      ...optional('verifier', request.headers.get(LINK_BUNDLE_HEADERS.verifier)),
    });
    const limits: LinkStoreLimits = { ...DEFAULT_LINK_STORE_LIMITS, perLink: headers.limits };
    const now = this.runtime.now();
    const daemonId = headers.daemon ?? '';
    const tokenVerifier = headers.verifier ?? '';
    switch (path) {
      case '/upload': {
        // The Worker has already checked the signature, the length and the digest; it forwards the frame as read.
        const frame = await decodeLinkUploadBody(frameCrypto, new Uint8Array(await request.arrayBuffer()));
        if (!frame.ok) return refusalResponse('link_bad_request');
        return this.answer(
          await this.run(
            headers.bundle,
            { type: 'upload', daemonId, metadata: frame.metadata, envelope: frame.envelope, now },
            limits,
          ),
        );
      }
      case '/delete':
        return this.answer(await this.run(headers.bundle, { type: 'delete', daemonId, now }, limits));
      case '/status':
        return this.answer(await this.run(headers.bundle, { type: 'status', daemonId, now }, limits));
      case '/peek':
        return this.answer(await this.run(headers.bundle, { type: 'peek', tokenVerifier, now }, limits));
      default:
        return this.answer(await this.run(headers.bundle, { type: 'fetch', tokenVerifier, now }, limits));
    }
  }

  private async run(bundleId: string, event: BundleEvent, limits: LinkStoreLimits): Promise<BundleStep> {
    const previous = await this.readDoc();
    const stored =
      event.type === 'fetch' && previous?.row.state === 'live' ? await this.readEnvelope(previous.chunks) : null;
    const step = reduceBundle(bundleId, previous, event, stored, limits);
    await this.persist(bundleId, previous, step);
    if (step.released && previous !== null) await this.release(previous.row.owner, bundleId);
    return step;
  }

  private async readDoc(): Promise<BundleDoc | null> {
    const raw = await this.objectState.storage.get<unknown>(DOC_KEY);
    if (raw === undefined) return null;
    const parsed = BundleDocSchema.safeParse(raw);
    if (!parsed.success) throw new LinkStoreStateDamagedError('a link row');
    return parsed.data;
  }

  /** The chunks in order. A missing or foreign one is damage: serving a truncated envelope would be worse than none. */
  private async readEnvelope(chunks: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (let index = 0; index < chunks; index += 1) {
      const part = await this.objectState.storage.get<unknown>(chunkKey(index));
      if (!(part instanceof Uint8Array)) throw new LinkStoreStateDamagedError('an envelope chunk');
      parts.push(part);
    }
    return joinChunks(parts);
  }

  /** One transaction for the row and its chunks, so a crash never leaves a link live without its bytes. */
  private async persist(bundleId: string, previous: BundleDoc | null, step: BundleStep): Promise<void> {
    const { storage } = this.objectState;
    if (previous === null && step.doc === null) return;
    const kept = step.doc?.chunks ?? 0;
    await storage.transaction(async transaction => {
      if (step.doc === null) {
        await transaction.delete(DOC_KEY);
        await transaction.delete(ID_KEY);
      } else {
        await transaction.put(DOC_KEY, step.doc);
        await transaction.put(ID_KEY, bundleId);
      }
      if (step.envelope instanceof Uint8Array) {
        const chunks = chunkEnvelope(step.envelope);
        for (const [index, chunk] of chunks.entries()) await transaction.put(chunkKey(index), chunk);
      }
      if (step.envelope !== 'keep') {
        for (let index = kept; index < (previous?.chunks ?? 0); index += 1) await transaction.delete(chunkKey(index));
      }
    });
    if (step.alarmAt === null) await storage.deleteAlarm();
    else await storage.setAlarm(step.alarmAt);
  }

  /** Tell the owner and control objects the slot is free. Best effort: the lease frees it at `notAfter` anyway. */
  private async release(owner: string, bundleId: string): Promise<void> {
    const body = JSON.stringify({ bundleId });
    await Promise.allSettled([
      objectFetch(this.environment.LINK_OWNER, linkOwnerObjectName(owner), '/release', { body }),
      objectFetch(this.environment.LINK_STORE_CONTROL, LINK_STORE_CONTROL_OBJECT_NAME, '/release', { body }),
    ]);
  }

  private answer(step: BundleStep): Response {
    const { response } = step;
    if (!response.ok) return refusalResponse(response.code);
    switch (response.kind) {
      case 'stored':
        return json({ version: LINK_STORE_VERSION, sequence: response.sequence });
      case 'status':
        return json(response.status);
      case 'peek':
        return json(response.peek);
      case 'fetch':
        return new Response(ownBuffer(response.envelope), {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store, max-age=0',
            [LINK_KIND_HEADER]: response.linkKind,
            [LINK_SEQUENCE_HEADER]: String(response.sequence),
          },
        });
      default:
        return json({ version: LINK_STORE_VERSION });
    }
  }
}

const optional = <K extends string>(key: K, value: string | null): { [P in K]?: string } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: string };

const frameCrypto = new WebCryptoSessionCrypto();

// ── Owner object ─────────────────────────────────────────────────────────────────────────────────

const SHARD_KEY = 'shard';

const OwnerReservationBody = z.strictObject({
  reservation: z.strictObject({
    bundleId: LinkBundleIdSchema,
    bytes: z.number().int().min(1).max(LINK_ENVELOPE_MAX_BYTES),
    until: z.number().int().min(0),
    create: z.boolean(),
  }),
  limits: LinkStoreLimitsSchema,
});
const OwnerUndoBody = z.strictObject({
  undo: z.strictObject({
    bundleId: LinkBundleIdSchema,
    previous: z.strictObject({ bytes: z.number(), until: z.number() }).nullable(),
    day: z.number(),
  }),
});

export class LinkOwnerDurableObject extends SerialisedObject {
  constructor(
    private readonly objectState: LinkObjectState,
    _environment: LinkStoreObjectEnvironment = {},
    private readonly runtime: LinkStoreRuntime = linkStoreRuntime,
  ) {
    super();
  }

  fetch(request: Request): Promise<Response> {
    return this.guarded(request, incoming => this.route(incoming));
  }

  alarm(): Promise<void> {
    return this.serialised(async () => {
      try {
        await this.commit(sweepOwner(await this.read(), this.runtime.now()));
      } catch (error) {
        this.runtime.log(`link store: an owner object's alarm failed because ${damageNote(error)}`);
        await this.objectState.storage.setAlarm(this.runtime.now() + 60_000);
      }
    });
  }

  protected failure(error: unknown): Response {
    this.runtime.log(`link store: an owner object failed because ${damageNote(error)}`);
    return refused('link_store_unavailable');
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const now = this.runtime.now();
    const shard = await this.read();
    switch (path) {
      case '/challenge': {
        const body = await bodyOf(request, z.strictObject({ nonce: z.string().min(1), limits: LinkStoreLimitsSchema }));
        const [next, gate] = ownerChallenge(shard, { nonce: body.nonce, now }, body.limits);
        await this.commit(next);
        return gate.ok ? json({ ok: true }) : refused(gate.code);
      }
      case '/spend': {
        const body = await bodyOf(request, z.strictObject({ nonce: z.string().min(1) }));
        const [next, spent] = ownerSpendNonce(shard, body.nonce, now);
        await this.commit(next);
        return json({ spent });
      }
      case '/reserve': {
        const body = await bodyOf(request, OwnerReservationBody);
        const [next, gate, undo] = ownerReserve(shard, { ...body.reservation, now }, body.limits);
        await this.commit(next);
        return gate.ok ? json({ ok: true, undo }) : refused(gate.code);
      }
      case '/undo': {
        const body = await bodyOf(request, OwnerUndoBody);
        await this.commit(ownerUndo(shard, body.undo));
        return json({ ok: true });
      }
      default: {
        const body = await bodyOf(request, z.strictObject({ bundleId: LinkBundleIdSchema }));
        await this.commit(ownerRelease(shard, body.bundleId));
        return json({ ok: true });
      }
    }
  }

  private async read(): Promise<OwnerShard> {
    const raw = await this.objectState.storage.get<unknown>(SHARD_KEY);
    if (raw === undefined) return EMPTY_OWNER_SHARD;
    const parsed = OwnerShardSchema.safeParse(raw);
    if (!parsed.success) throw new LinkStoreStateDamagedError('an owner row');
    return parsed.data;
  }

  /** Persist, or forget everything when nothing is left, and keep the one alarm on the next thing to forget. */
  private async commit(shard: OwnerShard): Promise<void> {
    const { storage } = this.objectState;
    const now = this.runtime.now();
    if (ownerIdle(shard, now)) {
      await storage.delete(SHARD_KEY);
      await storage.deleteAlarm();
      return;
    }
    await storage.put(SHARD_KEY, shard);
    const at = ownerAlarmAt(shard, now);
    if (at === null) await storage.deleteAlarm();
    else await storage.setAlarm(at);
  }
}

// ── Control object ───────────────────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'config';
const STATE_KEY = 'state';
const linkKey = (bundleId: string): string => `link:${bundleId}`;
const ownerKey = (daemonId: string): string => `owner:${daemonId}`;

const DEFAULT_CONFIG: LinkStoreConfig = { available: true, serving: true, limits: DEFAULT_LINK_STORE_LIMITS };

const Ip = z.string().min(1).max(64);
const ControlBodies = {
  admit: z.strictObject({ daemonId: z.string().min(1), op: z.enum(['upload', 'delete', 'status']) }),
  challenge: z.strictObject({ daemonId: z.string().min(1), ip: Ip }),
  reserve: z.strictObject({
    owner: z.string().min(1),
    bundleId: LinkBundleIdSchema,
    bytes: z.number().int().min(1).max(LINK_ENVELOPE_MAX_BYTES),
    until: z.number().int().min(0),
    create: z.boolean(),
  }),
  rollback: z.strictObject({
    bundleId: LinkBundleIdSchema,
    previous: LinkRecordSchema.nullable(),
    day: z.number(),
  }),
  release: z.strictObject({ bundleId: LinkBundleIdSchema }),
  open: z.strictObject({ type: z.enum(['peek', 'fetch']), bundleId: LinkBundleIdSchema, ip: Ip }),
  owned: z.strictObject({ owner: z.string().min(1), bundleIds: z.array(LinkBundleIdSchema).max(64) }),
} as const;

export class LinkStoreControlDurableObject extends SerialisedObject {
  private readonly challengeAll = new SlidingWindows(1);
  private readonly challengeByIp = new SlidingWindows(LINK_WINDOW_MAX_KEYS);
  private readonly openByIp = new SlidingWindows(LINK_WINDOW_MAX_KEYS);
  private readonly wrongUnknown = new SlidingWindows(LINK_WINDOW_MAX_KEYS);

  constructor(
    private readonly objectState: LinkObjectState,
    _environment: LinkStoreObjectEnvironment = {},
    private readonly runtime: LinkStoreRuntime = linkStoreRuntime,
  ) {
    super();
  }

  fetch(request: Request): Promise<Response> {
    return this.guarded(request, incoming => this.route(incoming));
  }

  /** Settle what is due: leases that ended become tombstones, tombstones and idle owners are forgotten. */
  alarm(): Promise<void> {
    return this.serialised(async () => {
      try {
        await this.settleDue();
      } catch (error) {
        this.runtime.log(`link store: the control object's alarm failed because ${damageNote(error)}`);
        await this.objectState.storage.setAlarm(this.runtime.now() + 60_000);
      }
    });
  }

  protected failure(error: unknown): Response {
    this.runtime.log(`link store: the control object failed because ${damageNote(error)}`);
    return refused('link_store_unavailable');
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const now = this.runtime.now();
    const config = await this.config();
    const { limits } = config;
    const taking = config.available && config.serving;
    switch (path) {
      case '/service':
        return json({
          version: LINK_STORE_VERSION,
          available: taking,
          maxEnvelopeBytes: LINK_ENVELOPE_MAX_BYTES,
          maxLiveLinks: limits.perDaemon.liveLinks,
        });
      case '/operator':
        return request.method === 'PUT' ? this.configure(config, request) : json(await this.operatorView(config));
      case '/admit': {
        const body = await bodyOf(request, ControlBodies.admit);
        if (body.op === 'upload' && !taking) return refused('link_store_unavailable');
        if ((await this.objectState.storage.get(ownerKey(body.daemonId))) === undefined)
          return refused('link_challenge_expired');
        return json({ ok: true, limits });
      }
      case '/challenge': {
        const body = await bodyOf(request, ControlBodies.challenge);
        const state = await this.state();
        const known = (await this.objectState.storage.get(ownerKey(body.daemonId))) !== undefined;
        const gate = controlChallengeGate(
          { available: taking, ownerKnown: known, ownersCount: state.owners, ip: body.ip, now },
          { global: this.challengeAll, byIp: this.challengeByIp },
          limits,
        );
        if (!gate.ok) return refused(gate.code);
        await this.objectState.storage.transaction(async tx => {
          await this.registerOwner(tx, state, body.daemonId, now + DAY_MS);
        });
        return json({ ok: true, limits });
      }
      case '/reserve':
        return this.reserve(await bodyOf(request, ControlBodies.reserve), config, now);
      case '/rollback':
        return this.rollback(await bodyOf(request, ControlBodies.rollback));
      case '/release':
        return this.releaseRecord((await bodyOf(request, ControlBodies.release)).bundleId, now);
      case '/open': {
        const body = await bodyOf(request, ControlBodies.open);
        const state = await this.state();
        const verdict = controlOpenVerdict(
          {
            serving: config.serving,
            known: (await this.objectState.storage.get(linkKey(body.bundleId))) !== undefined,
            type: body.type,
            bundleId: body.bundleId,
            ip: body.ip,
            fetchesToday: countedToday(state.fetches, now),
            now,
          },
          { byIp: this.openByIp, wrongUnknown: this.wrongUnknown },
          limits,
        );
        if (verdict.kind === 'refuse') return refused(verdict.code);
        return json(
          verdict.kind === 'gone'
            ? { ok: true, verdict: 'gone' }
            : { ok: true, verdict: 'proceed', perLink: limits.perLink },
        );
      }
      case '/fetched': {
        const state = await this.state();
        await this.objectState.storage.put(STATE_KEY, {
          ...state,
          fetches: { day: dayOf(now), count: countedToday(state.fetches, now) + 1 },
        });
        return json({ ok: true });
      }
      default: {
        const body = await bodyOf(request, ControlBodies.owned);
        const owned: string[] = [];
        for (const bundleId of body.bundleIds) {
          if ((await this.record(bundleId))?.owner === body.owner) owned.push(bundleId);
        }
        return json({ ok: true, owned });
      }
    }
  }

  private async configure(current: LinkStoreConfig, request: Request): Promise<Response> {
    const parsed = LinkStoreOperatorUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return json({ error: 'invalid link store settings' }, 400);
    const next: LinkStoreConfig = {
      available: parsed.data.available ?? current.available,
      serving: parsed.data.serving ?? current.serving,
      limits: parsed.data.limits ?? current.limits,
    };
    await this.objectState.storage.put(CONFIG_KEY, next);
    return json(await this.operatorView(next));
  }

  private async operatorView(config: LinkStoreConfig) {
    const { totals, owners } = await this.state();
    return {
      ...config,
      metrics: { owners, liveLinks: totals.live, storedBytes: totals.bytes, tombstones: totals.tombs },
    };
  }

  private async reserve(
    body: z.infer<typeof ControlBodies.reserve>,
    config: LinkStoreConfig,
    now: number,
  ): Promise<Response> {
    const { storage } = this.objectState;
    const state = await this.state();
    const record = await this.record(body.bundleId);
    const gate = controlReserveGate(
      {
        available: config.available && config.serving,
        owner: body.owner,
        create: body.create,
        bytes: body.bytes,
        record,
        ownerKnown: (await storage.get(ownerKey(body.owner))) !== undefined,
        ownersCount: state.owners,
        totals: state.totals,
        uploadsToday: countedToday(state.uploads, now),
      },
      config.limits,
    );
    if (!gate.ok) return refused(gate.code);
    const leased: LinkRecord = { owner: body.owner, bytes: body.bytes, until: body.until, phase: 'leased' };
    await storage.transaction(async tx => {
      const next = await this.registerOwner(tx, state, body.owner, body.until + DAY_MS);
      await this.commitRecord(tx, next, body.bundleId, record, leased, {
        uploads: { day: dayOf(now), count: countedToday(state.uploads, now) + 1 },
      });
    });
    return json({ ok: true, limits: config.limits, previous: record, day: dayOf(now) });
  }

  /** A definite refusal downstream: put the record as it was and stop counting the upload. */
  private async rollback(body: z.infer<typeof ControlBodies.rollback>): Promise<Response> {
    const state = await this.state();
    const current = await this.record(body.bundleId);
    await this.objectState.storage.transaction(async tx => {
      await this.commitRecord(tx, state, body.bundleId, current, body.previous, {
        uploads:
          state.uploads.day === body.day
            ? { day: body.day, count: Math.max(0, state.uploads.count - 1) }
            : state.uploads,
      });
    });
    return json({ ok: true });
  }

  /** The link stopped being live: its quota is free and its id is remembered as a tombstone. */
  private async releaseRecord(bundleId: string, now: number): Promise<Response> {
    const record = await this.record(bundleId);
    if (record?.phase !== 'leased') return json({ ok: true });
    const state = await this.state();
    const tomb: LinkRecord = { owner: record.owner, bytes: 0, until: Math.max(record.until, now), phase: 'tomb' };
    await this.objectState.storage.transaction(async tx => {
      await this.commitRecord(tx, state, bundleId, record, tomb, {});
    });
    return json({ ok: true });
  }

  private async config(): Promise<LinkStoreConfig> {
    const raw = await this.objectState.storage.get<unknown>(CONFIG_KEY);
    if (raw === undefined) return DEFAULT_CONFIG;
    const parsed = LinkStoreConfigSchema.safeParse(raw);
    if (!parsed.success) throw new LinkStoreStateDamagedError('the operator settings');
    return parsed.data;
  }

  private async state(): Promise<ControlState> {
    const raw = await this.objectState.storage.get<unknown>(STATE_KEY);
    if (raw === undefined) return EMPTY_CONTROL_STATE;
    const parsed = ControlStateSchema.safeParse(raw);
    if (!parsed.success) throw new LinkStoreStateDamagedError('the counters');
    return parsed.data;
  }

  private async record(bundleId: string): Promise<LinkRecord | null> {
    const raw = await this.objectState.storage.get<unknown>(linkKey(bundleId));
    if (raw === undefined) return null;
    const parsed = LinkRecordSchema.safeParse(raw);
    if (!parsed.success) throw new LinkStoreStateDamagedError('a registry entry');
    return parsed.data;
  }

  /** Write a record, move its place in the due index, keep the totals true and the alarm no later than its due time. */
  private async commitRecord(
    tx: HostedRelayControlStorageTransaction,
    state: ControlState,
    bundleId: string,
    before: LinkRecord | null,
    after: LinkRecord | null,
    changes: Partial<Pick<ControlState, 'uploads' | 'fetches'>>,
  ): Promise<void> {
    if (before !== null) await tx.delete(dueKey(linkRecordDueAt(before), 'l', bundleId));
    if (after === null) await tx.delete(linkKey(bundleId));
    else {
      await tx.put(linkKey(bundleId), after);
      await tx.put(dueKey(linkRecordDueAt(after), 'l', bundleId), 1);
    }
    await tx.put(STATE_KEY, { ...state, ...changes, totals: replaceRecordTotals(state.totals, before, after) });
    if (after !== null) await this.armAt(linkRecordDueAt(after));
  }

  /** Remember a daemon until `until`, counting it once. Returns the counters as they now stand. */
  private async registerOwner(
    tx: HostedRelayControlStorageTransaction,
    state: ControlState,
    daemonId: string,
    until: number,
  ): Promise<ControlState> {
    const current = await tx.get<number>(ownerKey(daemonId));
    if (current !== undefined && current >= until) return state;
    if (current !== undefined) await tx.delete(dueKey(current, 'o', daemonId));
    await tx.put(ownerKey(daemonId), until);
    await tx.put(dueKey(until, 'o', daemonId), 1);
    const next = current === undefined ? { ...state, owners: state.owners + 1 } : state;
    await tx.put(STATE_KEY, next);
    await this.armAt(until);
    return next;
  }

  private async armAt(at: number): Promise<void> {
    const { storage } = this.objectState;
    const current = await storage.getAlarm();
    if (current === null || at < current) await storage.setAlarm(at);
  }

  private async settleDue(): Promise<void> {
    const { storage } = this.objectState;
    const now = this.runtime.now();
    const due = await storage.list<number>({ prefix: 'due:', limit: DUE_BATCH });
    for (const key of due.keys()) {
      const entry = parseDueKey(key);
      if (entry === null || entry.at > now) break;
      if (entry.kind === 'o') await this.forgetOwner(key, entry.id);
      else await this.settleLink(key, entry.id);
    }
    const next = await storage.list<number>({ prefix: 'due:', limit: 1 });
    const first = [...next.keys()][0];
    if (first === undefined) return storage.deleteAlarm();
    const at = parseDueKey(first)?.at ?? now;
    await storage.setAlarm(at > now ? at : now + 1_000);
  }

  private async forgetOwner(key: string, daemonId: string): Promise<void> {
    const until = await this.objectState.storage.get<number>(ownerKey(daemonId));
    await this.objectState.storage.transaction(async tx => {
      await tx.delete(key);
      if (until === undefined || dueKey(until, 'o', daemonId) !== key) return;
      await tx.delete(ownerKey(daemonId));
      const state = await this.state();
      await tx.put(STATE_KEY, { ...state, owners: Math.max(0, state.owners - 1) });
    });
  }

  private async settleLink(key: string, bundleId: string): Promise<void> {
    const record = await this.record(bundleId);
    if (record === null || dueKey(linkRecordDueAt(record), 'l', bundleId) !== key) {
      await this.objectState.storage.delete(key);
      return;
    }
    const next: LinkRecord | null =
      record.phase === 'leased' ? { owner: record.owner, bytes: 0, until: record.until, phase: 'tomb' } : null;
    const state = await this.state();
    await this.objectState.storage.transaction(async tx => {
      await this.commitRecord(tx, state, bundleId, record, next, {});
    });
  }
}
