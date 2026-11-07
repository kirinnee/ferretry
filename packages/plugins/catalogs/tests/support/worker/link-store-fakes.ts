/**
 * The link store's runtime, faked down to what its adapters touch.
 *
 * The three Durable Objects here are the REAL classes, built on an in-memory storage and reached through
 * namespaces that route `idFromName` to one instance per name — which is what Cloudflare does, minus the
 * isolation. What is proved is the adapters' half of the contract; that Cloudflare behaves as these fakes do
 * is only ever shown by a real deployment, and the protocol document says so.
 */
import {
  type LinkObjectStorage,
  type LinkStoreEnvironment,
  type LinkStoreObjectEnvironment,
  type LinkStoreRuntime,
  LinkBundleDurableObject,
  LinkOwnerDurableObject,
  LinkStoreControlDurableObject,
  linkStoreFetch,
} from '../../../worker/adapters/index.ts';
import type { HostedRelayControlNamespace } from '../../../worker/adapters/durable-storage.ts';
import {
  type DaemonIdentity,
  encodeLinkUploadBody,
  fromBase64UrlFixed,
  linkBundlePath,
  linkFetchPath,
  linkPeekPath,
  type LinkStoreLimits,
  type LinkUploadMetadata,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_OPERATOR_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  linkUploadSignedBody,
  signLinkStoreRequest,
  toBase64Url,
} from '../../../worker/lib/index.ts';
import { FakeHostedRelayControlStorage } from './hosted-control-fakes.ts';
import { relayCrypto } from './identities.ts';
import { LINK_AT } from './links.ts';

const LINK_HOST = 'link.example.test';
const LINK_OPERATOR = 'link-operator-bearer-secret';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Durable Object storage as the link store uses it: byte-ordered, cloned on the way in and out, one alarm. */
export class FakeLinkObjectStorage extends FakeHostedRelayControlStorage implements LinkObjectStorage {
  alarm: number | null = null;

  override async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  override async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  keys(prefix = ''): string[] {
    return [...this.values.keys()].filter(key => key.startsWith(prefix)).sort();
  }
}

export type ObjectKind = 'bundle' | 'owner' | 'control';
/** Who is asking: the public Worker, or another object (the bundle object's best-effort release). */
export type Origin = 'worker' | 'object';

export interface Fault {
  readonly target: ObjectKind;
  readonly from?: Origin;
  /** The internal route, `/release`; every route when left out. */
  readonly route?: string;
  /**
   * `throw` rejects the call, `throw-sync` throws from `idFromName`, `garble` answers with text that is not
   * JSON, `refuse` answers `link_store_unavailable` in the objects' own refusal shape without asking the object,
   * `cookie` adds a Set-Cookie to a real answer.
   */
  readonly mode: 'throw' | 'throw-sync' | 'garble' | 'refuse' | 'cookie';
}

interface LiveObject {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly alarm: () => Promise<void>;
  readonly storage: FakeLinkObjectStorage;
}

export interface Recorded {
  readonly path: string;
  readonly status: number;
  readonly headers: Headers;
}

export interface WorldOptions {
  /** Raise the challenge limits so a test can sign many requests; the default store is otherwise exactly as shipped. */
  readonly relaxed?: boolean;
  readonly mode?: string | undefined;
  readonly daemonIds?: string;
}

/** Everything the three objects share: one clock, one log, one registry of what was instantiated. */
export class LinkStoreWorld {
  readonly clock = { now: Date.parse(LINK_AT) };
  readonly logs: string[] = [];
  readonly faults: Fault[] = [];
  readonly responses: Recorded[] = [];
  /** Strings that must never reach a log line. */
  readonly sensitive = new Set<string>();
  readonly runtime: LinkStoreRuntime = {
    now: () => this.clock.now,
    log: message => {
      this.logs.push(message);
    },
  };
  /** Bindings the objects themselves lack, to prove the bundle object's release is best effort. */
  readonly missingFromObjects = new Set<ObjectKind>();
  private readonly live = new Map<ObjectKind, Map<string, LiveObject>>([
    ['bundle', new Map()],
    ['owner', new Map()],
    ['control', new Map()],
  ]);
  private readonly mode: string | undefined;
  private readonly daemonIds: string | undefined;

  constructor(options: WorldOptions = {}) {
    this.mode = 'mode' in options ? options.mode : 'hosted';
    this.daemonIds = options.daemonIds;
  }

  advance(ms: number): void {
    this.clock.now += ms;
  }

  /** Names of the objects that exist, which is how a test proves an id cost no object. */
  names(kind: ObjectKind): string[] {
    return [...(this.live.get(kind)?.keys() ?? [])];
  }

  get created(): number {
    return this.names('bundle').length + this.names('owner').length + this.names('control').length;
  }

  storageOf(kind: ObjectKind, name: string): FakeLinkObjectStorage | undefined {
    return this.live.get(kind)?.get(name)?.storage;
  }

  /** The only object of a kind there is exactly one of. */
  get control(): FakeLinkObjectStorage {
    const [name] = this.names('control');
    const storage = name === undefined ? undefined : this.storageOf('control', name);
    if (storage === undefined) throw new Error('the control object was never instantiated');
    return storage;
  }

  owner(daemonId: string): FakeLinkObjectStorage | undefined {
    return this.storageOf('owner', `ferretry-link-owner/1:${daemonId}`);
  }

  bundle(bundleId: string): FakeLinkObjectStorage | undefined {
    return this.storageOf('bundle', `ferretry-link/1:${bundleId}`);
  }

  private instance(kind: ObjectKind, name: string): LiveObject {
    const registry = this.live.get(kind);
    if (registry === undefined) throw new Error('unknown kind');
    const existing = registry.get(name);
    if (existing !== undefined) return existing;
    const storage = new FakeLinkObjectStorage();
    const state = { storage };
    const world = this;
    const environment: LinkStoreObjectEnvironment = {
      get LINK_OWNER() {
        return world.missingFromObjects.has('owner') ? undefined : world.namespace('owner', 'object');
      },
      get LINK_STORE_CONTROL() {
        return world.missingFromObjects.has('control') ? undefined : world.namespace('control', 'object');
      },
    };
    const object =
      kind === 'bundle'
        ? new LinkBundleDurableObject(state, environment, this.runtime)
        : kind === 'owner'
          ? new LinkOwnerDurableObject(state, environment, this.runtime)
          : new LinkStoreControlDurableObject(state, environment, this.runtime);
    const made: LiveObject = {
      fetch: request => object.fetch(request),
      alarm: () => object.alarm(),
      storage,
    };
    registry.set(name, made);
    return made;
  }

  /** A namespace that routes each name to its own real object, with the faults a test has armed. */
  namespace(kind: ObjectKind, from: Origin): HostedRelayControlNamespace {
    const matching = (route?: string) =>
      this.faults.filter(
        fault =>
          fault.target === kind &&
          (fault.from ?? 'worker') === from &&
          (fault.route === undefined || fault.route === route),
      );
    return {
      idFromName: name => {
        if (this.faults.some(f => f.target === kind && (f.from ?? 'worker') === from && f.mode === 'throw-sync'))
          throw new Error('idFromName failed');
        return name;
      },
      get: id => ({
        fetch: async request => {
          const route = new URL(request.url).pathname;
          const faults = matching(route);
          if (faults.some(fault => fault.mode === 'throw')) throw new Error('the object is unreachable');
          if (faults.some(fault => fault.mode === 'refuse'))
            return new Response(JSON.stringify({ ok: false, code: 'link_store_unavailable' }), { status: 200 });
          const answered = await this.instance(kind, String(id)).fetch(request);
          if (faults.some(fault => fault.mode === 'garble')) return new Response('not json at all', { status: 200 });
          if (faults.some(fault => fault.mode === 'cookie')) {
            const headers = new Headers(answered.headers);
            headers.append('Set-Cookie', 'session=abc; Path=/');
            return new Response(answered.body, { status: answered.status, headers });
          }
          return answered;
        },
      }),
    };
  }

  /** The Worker's bindings. `omit` leaves one out; `mode`/`daemonIds`/`operatorToken` override the world's. */
  environment(
    overrides: {
      readonly omit?: readonly ObjectKind[];
      readonly mode?: string | undefined;
      readonly daemonIds?: string | undefined;
      readonly operatorToken?: string | undefined;
    } = {},
  ): LinkStoreEnvironment {
    const omit = new Set(overrides.omit ?? []);
    return {
      ...(omit.has('bundle') ? {} : { LINK_BUNDLE: this.namespace('bundle', 'worker') }),
      ...(omit.has('owner') ? {} : { LINK_OWNER: this.namespace('owner', 'worker') }),
      ...(omit.has('control') ? {} : { LINK_STORE_CONTROL: this.namespace('control', 'worker') }),
      LINK_STORE_MODE: 'mode' in overrides ? overrides.mode : this.mode,
      LINK_STORE_DAEMON_IDS: 'daemonIds' in overrides ? overrides.daemonIds : this.daemonIds,
      LINK_STORE_OPERATOR_TOKEN: 'operatorToken' in overrides ? overrides.operatorToken : LINK_OPERATOR,
    };
  }

  /** A request, built the way a caller on the internet sends one. */
  request(
    method: string,
    path: string,
    options: {
      readonly body?: string | Uint8Array;
      readonly ip?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly contentLength?: number;
    } = {},
  ): Request {
    const headers = new Headers(options.headers);
    if (options.ip !== undefined) {
      headers.set('CF-Connecting-IP', options.ip);
      this.sensitive.add(options.ip);
    }
    const built = new Request(`https://${LINK_HOST}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    return options.contentLength === undefined ? built : lyingAboutLength(built, options.contentLength);
  }

  /** Send one request to the Worker and keep what came back, so the header rules can be checked once for all. */
  async send(request: Request, environment: LinkStoreEnvironment = this.environment()): Promise<Response> {
    const response = await linkStoreFetch(request, environment, this.runtime);
    this.responses.push({ path: new URL(request.url).pathname, status: response.status, headers: response.headers });
    return response;
  }

  call(
    method: string,
    path: string,
    options: Parameters<LinkStoreWorld['request']>[2] & { readonly environment?: LinkStoreEnvironment } = {},
  ): Promise<Response> {
    return this.send(this.request(method, path, options), options.environment);
  }

  json(method: string, path: string, value: unknown, options: Parameters<LinkStoreWorld['call']>[2] = {}) {
    return this.call(method, path, { ...options, body: JSON.stringify(value) });
  }

  advertisement(): Promise<Response> {
    return this.call('GET', LINK_STORE_SERVICE_PATH);
  }

  /** Peek or fetch with whatever text the caller puts in the body. */
  open(
    action: 'peek' | 'fetch',
    bundleId: string,
    token: string,
    options: Parameters<LinkStoreWorld['call']>[2] = {},
  ): Promise<Response> {
    return this.json('POST', action === 'peek' ? linkPeekPath(bundleId) : linkFetchPath(bundleId), { token }, options);
  }

  operator(
    method: string,
    value?: unknown,
    token: string | null = LINK_OPERATOR,
    options: Parameters<LinkStoreWorld['call']>[2] = {},
  ): Promise<Response> {
    return this.call(method, LINK_STORE_OPERATOR_PATH, {
      ...options,
      ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }),
      headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...options.headers },
    });
  }

  /** The operator's view of the limits and the totals. */
  async view(): Promise<{
    available: boolean;
    serving: boolean;
    limits: LinkStoreLimits;
    metrics: { owners: number; liveLinks: number; storedBytes: number; tombstones: number };
  }> {
    return (await this.operator('GET')).json() as never;
  }

  /** Replace the limits with the ones in force, changed as the test needs. */
  async limits(
    patch: {
      readonly [K in keyof LinkStoreLimits]?: Partial<LinkStoreLimits[K]>;
    },
  ): Promise<Response> {
    const current = (await this.view()).limits;
    const merged = Object.fromEntries(
      Object.entries(current).map(([group, values]) => [
        group,
        { ...values, ...(patch as Record<string, object>)[group] },
      ]),
    );
    return this.operator('PUT', { limits: merged });
  }

  /** Raise the challenge limits so one daemon can sign a long run of requests. */
  relax(): Promise<Response> {
    return this.limits({
      challenge: { unspentPerDaemon: 100, perDaemonPerMinute: 1000, globalPerMinute: 1000 },
      perIp: { challengesPerMinute: 1000 },
    });
  }

  /**
   * Fire every alarm that is due, the way Cloudflare does: the alarm is cleared first, the handler may set
   * another, and the run goes on until nothing more is due. Returns how many fired.
   */
  async fireAlarms(): Promise<number> {
    let fired = 0;
    for (let round = 0; round < 50; round += 1) {
      const due = [...this.live.values()]
        .flatMap(registry => [...registry.values()])
        .filter(object => object.storage.alarm !== null && object.storage.alarm <= this.clock.now);
      if (due.length === 0) return fired;
      for (const object of due) {
        object.storage.alarm = null;
        await object.alarm();
        fired += 1;
      }
    }
    throw new Error('alarms did not settle');
  }

  /** Every log line is one of the fixed sentences and names nothing it was given. */
  assertLogsFixed(): void {
    const fixed = [
      /^link store: LINK_STORE_MODE is not hosted or self-hosted, so it serves nobody$/u,
      /^link store: a request failed unexpectedly$/u,
      /^link store: (?:a bundle object|an owner object|the control object)(?:'s alarm)? failed because (?:its stored state is damaged|it failed unexpectedly)$/u,
    ];
    for (const line of this.logs) {
      if (!fixed.some(pattern => pattern.test(line))) throw new Error(`a log line is not a fixed sentence: ${line}`);
      for (const secret of this.sensitive) {
        if (line.includes(secret)) throw new Error('a log line names something it must not');
      }
    }
  }

  /** The header rules every public answer keeps, whatever it says. */
  assertPublicHeaders(): void {
    const publicAnswers = this.responses.filter(recorded => recorded.path !== LINK_STORE_OPERATOR_PATH);
    if (publicAnswers.length === 0) throw new Error('nothing was sent');
    for (const recorded of publicAnswers) {
      const cache = recorded.headers.get('Cache-Control');
      const origin = recorded.headers.get('Access-Control-Allow-Origin');
      if (cache !== 'no-store, max-age=0')
        throw new Error(`${recorded.path} ${recorded.status}: Cache-Control is ${cache}`);
      if (origin !== '*')
        throw new Error(`${recorded.path} ${recorded.status}: Access-Control-Allow-Origin is ${origin}`);
      if (recorded.headers.get('Set-Cookie') !== null) throw new Error(`${recorded.path}: Set-Cookie was sent`);
    }
  }
}

/** A request whose Content-Length says something other than what the body is: the runtime may drop the header, so it is overridden. */
function lyingAboutLength(request: Request, length: number): Request {
  const headers = new Headers(request.headers);
  headers.set('Content-Length', String(length));
  return new Proxy(request, {
    get(target, property) {
      if (property === 'headers') return headers;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export async function linkStoreWorld(options: WorldOptions = {}): Promise<LinkStoreWorld> {
  const world = new LinkStoreWorld(options);
  if (options.relaxed ?? true) {
    const relaxed = await world.relax();
    if (relaxed.status !== 200) throw new Error(`could not relax the limits: ${relaxed.status}`);
  }
  return world;
}

// ── The daemon's half ────────────────────────────────────────────────────────────────────────────

const bytesAt = (length: number, sequence: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  bytes.set(new TextEncoder().encode('FYL1'), 0);
  new DataView(bytes.buffer).setUint32(4, sequence, false);
  return bytes;
};

/** A bundle id the way a daemon mints one: 16 random bytes, spelled base64url. */
export const newBundleId = (): string => toBase64Url(relayCrypto.randomBytes(16));

export interface UploadSpec {
  readonly bundleId?: string;
  readonly kind?: 'public' | 'one-time';
  readonly action?: 'create' | 'replace';
  readonly sequence?: number;
  readonly expectSequence?: number;
  /** From now: a public link defaults to a week, a one-time link to an hour. */
  readonly lastsMs?: number;
  readonly expiresInMs?: number;
  readonly installCap?: number;
  readonly bytes?: number;
  /** The sequence the envelope's own header carries, when it should differ from the metadata's. */
  readonly envelopeSequence?: number;
  /** A nonce already obtained, instead of asking for one. */
  readonly nonce?: string;
  /** The 32 bytes the link's token is: random unless given. */
  readonly token?: Uint8Array;
  readonly ip?: string;
  /** Sign with another key than the claimed daemon's. */
  readonly signWith?: DaemonIdentity;
  readonly environment?: LinkStoreEnvironment;
  /** Replace the whole body after it is built (a truncated frame, a flipped byte). */
  readonly mangle?: (body: Uint8Array) => Uint8Array;
}

export interface Uploaded {
  readonly response: Response;
  readonly bundleId: string;
  /** The token as a link carries it: base64url of 32 bytes. */
  readonly token: string;
  readonly envelope: Uint8Array;
  readonly metadata: LinkUploadMetadata;
  readonly nonce: string;
}

export class LinkStoreClient {
  constructor(
    readonly world: LinkStoreWorld,
    readonly identity: DaemonIdentity,
  ) {
    world.sensitive.add(identity.daemonId);
  }

  get daemonId(): string {
    return this.identity.daemonId;
  }

  challenge(options: { readonly ip?: string; readonly environment?: LinkStoreEnvironment } = {}): Promise<Response> {
    return this.world.json('POST', LINK_STORE_CHALLENGE_PATH, { daemonId: this.daemonId }, options);
  }

  /** A fresh nonce, or the failure of the request that should have issued it. */
  async nonce(options: { readonly ip?: string } = {}): Promise<string> {
    const response = await this.challenge(options);
    if (response.status !== 200) throw new Error(`no nonce: ${response.status}`);
    const issued = (await response.json()) as { nonce: string };
    this.world.sensitive.add(issued.nonce);
    return issued.nonce;
  }

  private async signed(
    nonce: string,
    signWith: DaemonIdentity | undefined,
    body: Parameters<typeof signLinkStoreRequest>[2]['body'],
  ) {
    const bytes = fromBase64UrlFixed(nonce, 32);
    if (bytes === null) throw new Error('not a nonce');
    return signLinkStoreRequest(relayCrypto, signWith ?? this.identity, {
      daemonId: this.daemonId,
      host: LINK_HOST,
      nonce: bytes,
      body,
    });
  }

  async upload(spec: UploadSpec = {}): Promise<Uploaded> {
    const kind = spec.kind ?? 'public';
    const action = spec.action ?? 'create';
    const bundleId = spec.bundleId ?? newBundleId();
    const sequence = spec.sequence ?? 1;
    const bytes = spec.bytes ?? 16_500;
    const envelope = bytesAt(bytes, spec.envelopeSequence ?? sequence);
    const tokenBytes = spec.token ?? relayCrypto.randomBytes(32);
    const token = toBase64Url(tokenBytes);
    const fetchVerifier = toBase64Url(await relayCrypto.sha256(tokenBytes));
    const notAfter = new Date(
      this.world.clock.now + (spec.lastsMs ?? (kind === 'one-time' ? HOUR : 7 * DAY)),
    ).toISOString();
    const expiresAt =
      spec.expiresInMs === undefined ? undefined : new Date(this.world.clock.now + spec.expiresInMs).toISOString();
    const nonce = spec.nonce ?? (await this.nonce(spec.ip === undefined ? {} : { ip: spec.ip }));
    for (const secret of [bundleId, token, fetchVerifier]) this.world.sensitive.add(secret);
    const signedFields = {
      action,
      kind,
      sequence,
      ...(spec.expectSequence === undefined ? {} : { expectSequence: spec.expectSequence }),
      notAfter,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(spec.installCap === undefined ? {} : { installCap: spec.installCap }),
      fetchVerifier,
      envelopeSha256: toBase64Url(await relayCrypto.sha256(envelope)),
      envelopeBytes: bytes,
    };
    const signature = await this.signed(
      nonce,
      spec.signWith,
      linkUploadSignedBody(bundleId, signedFields as unknown as LinkUploadMetadata),
    );
    const metadata = { ...signature, ...signedFields } as unknown as LinkUploadMetadata;
    const frame = encodeLinkUploadBody(metadata, envelope);
    const response = await this.world.call('PUT', linkBundlePath(bundleId), {
      body: (spec.mangle ?? ((body: Uint8Array) => body))(frame),
      ...(spec.ip === undefined ? {} : { ip: spec.ip }),
      ...(spec.environment === undefined ? {} : { environment: spec.environment }),
    });
    return { response, bundleId, token, envelope, metadata, nonce };
  }

  async remove(
    bundleId: string,
    options: {
      readonly nonce?: string;
      readonly signWith?: DaemonIdentity;
      readonly environment?: LinkStoreEnvironment;
    } = {},
  ): Promise<Response> {
    const nonce = options.nonce ?? (await this.nonce());
    const signature = await this.signed(nonce, options.signWith, { request: 'delete', bundleId });
    return this.world.json('DELETE', linkBundlePath(bundleId), signature, {
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
  }

  async status(
    bundleIds: readonly string[],
    options: { readonly nonce?: string; readonly environment?: LinkStoreEnvironment } = {},
  ): Promise<Response> {
    const nonce = options.nonce ?? (await this.nonce());
    const signature = await this.signed(nonce, undefined, { request: 'status', bundleIds });
    return this.world.json(
      'POST',
      LINK_STORE_STATUS_PATH,
      { ...signature, bundleIds },
      options.environment === undefined ? {} : { environment: options.environment },
    );
  }

  /** The states of the named links, by id. */
  async states(bundleIds: readonly string[]): Promise<Record<string, string>> {
    const response = await this.status(bundleIds);
    if (response.status !== 200) throw new Error(`status failed: ${response.status}`);
    const body = (await response.json()) as { links: { bundleId: string; state: string }[] };
    return Object.fromEntries(body.links.map(link => [link.bundleId, link.state]));
  }
}

/** One answer reduced to the parts that must be equal byte for byte. */
export async function bytesOf(response: Response): Promise<{
  readonly status: number;
  readonly text: string;
  readonly contentType: string | null;
  readonly cache: string | null;
  readonly origin: string | null;
}> {
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get('Content-Type'),
    cache: response.headers.get('Cache-Control'),
    origin: response.headers.get('Access-Control-Allow-Origin'),
  };
}
