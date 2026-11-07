/**
 * CATALOGS, COMPOSED AS THE DAEMON COMPOSES IT, for host-level tests (§3.9, §7.8).
 *
 * The real `daemon/index.ts` half is built by the kernel's `testHost` with Gate's, Access's, Vault's and Connections'
 * own contract fakes, so its routes, jobs, state files and events run as they do under the kernel. Two production
 * pieces of the kernel are then put in front of the SAME half:
 * - the kernel's `Dispatcher` (`@ferretry/kernel/host`), which sends a member principal to the member table only;
 * - the kernel's session layer (`createSessionLayer`), driven by a browser end speaking the real records over real
 *   WebCrypto, with Catalogs' own `session.modes:member` provider as the only mode.
 *
 * Fakes are only what Catalogs does not own: who is calling (Gate's StandInAdmission), the passkey verifier, the
 * clock, the daemon's identity signer (TODO(kernel contract): `kernel.identity` / `kernel.signer` are on
 * rebuild/port-kernel; until they reach rebuild/5.0 the half is given them here exactly as that branch shapes them).
 */
import {
  type Admission,
  type AdmissionDecision,
  type InventoryEntry,
  type ScopedRoute,
  type AdmissionInput,
  type ApiRequest,
  type ApiResponse,
  type CallStanding,
  type CarrierKey,
  type CarrierLink,
  type CarrierPeer,
  errorResponse,
  type FerretId,
  type HolderId,
  isSessionEnd,
  type MemberStanding,
  type SessionEnd,
  type SessionMode,
  type StatePort,
} from '@ferretry/kernel/contract';
import { Dispatcher, type MountedMemberRoute, type MountedRoute, session } from '@ferretry/kernel/host';
import { type DrivenClock, fixedClock, type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  deviceStanding,
  FakeGate,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
} from '@ferretry/core-gate/contract/testing';
import type { CapabilityGrants, CredentialProvider, StepUpWitness } from '@ferretry/core-gate/contract';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import type { Instant } from '@ferretry/std';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { fakeAccess } from '@ferretry/plugin-access/contract/testing';
import type { PasskeyVerifier } from '@ferretry/plugin-access/contract';
import { fakeConnections } from '@ferretry/plugin-connections/contract/testing';
import type { PublishedCarriers } from '@ferretry/plugin-connections/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { CatalogItems, type CatalogMcpProvider, type McpSourceServer } from '../../contract/items/index.ts';
import catalogsDaemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';
import type { ConnectionAdvertisement } from '../../daemon/adapters/host-facts.ts';
import type { CatalogSigningIdentity } from '../../daemon/adapters/signatures.ts';
import {
  catalogLinkSignedBytes,
  catalogManifestSignedBytes,
  catalogVersionsSignedBytes,
} from '../../contract/wire/index.ts';
import { WebCryptoSessionCrypto as CatalogWireCrypto, toBase64Url } from '../../worker/kernel-wire/index.ts';

export const kernelCrypto = new session.WebCryptoSessionCrypto();
const wireCrypto = new CatalogWireCrypto();

export const APP_ORIGIN = 'https://app.ferretry.test';
export const LOOPBACK_URL = 'http://127.0.0.1:4141';
export const DISCOVERED_RELAY = 'wss://relay.ferretry.test/v1/daemon';
export const START = '2026-11-07T09:00:00.000Z';
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

function toPem(der: ArrayBuffer | Uint8Array): string {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const base64 = btoa(String.fromCharCode(...bytes));
  return ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join(
    '\n',
  );
}

/** An accepting WebAuthn verifier: a member passkey ceremony is not what these tests are about. */
export const CREDENTIAL = new TextEncoder().encode('credential-one');
export function acceptingVerifier(): PasskeyVerifier & { refuse: boolean; counter: number } {
  const verifier = {
    refuse: false,
    counter: 0,
    verifyRegistration: async (input: Parameters<PasskeyVerifier['verifyRegistration']>[0]) =>
      verifier.refuse
        ? ({ ok: false, reason: 'refused by the test' } as const)
        : ({
            ok: true,
            value: {
              credentialId: CREDENTIAL,
              algorithm: -7 as const,
              publicKeySpki: new Uint8Array(91).fill(4),
              signCount: 0,
              origin: input.allowedOrigins[0] ?? APP_ORIGIN,
            },
          } as const),
    verifyAssertion: async (input: Parameters<PasskeyVerifier['verifyAssertion']>[0]) =>
      verifier.refuse
        ? ({ ok: false, reason: 'refused by the test' } as const)
        : ({
            ok: true,
            value: { signCount: ++verifier.counter, origin: input.allowedOrigins[0] ?? APP_ORIGIN },
          } as const),
  };
  return verifier;
}

/** Who a test-host caller is, as Gate would stand them; the device's step-up the test controls. */
export interface Callers {
  /** The device's own grants and whether it presented a step-up. */
  device: { grants: CapabilityGrants; stepUp: boolean };
  /** Acts a fresh passkey proof is held for: each is claimable ONCE (Gate's atomic claim). */
  readonly fresh: Set<string>;
  /** Every claim asked, in order, and whether it was granted. */
  readonly claims: { readonly act: string; readonly granted: boolean }[];
  /** Every member admission asked, in order: the path and the principal's session. */
  readonly memberAdmissions: { readonly path: string; readonly session: string }[];
}

function standingOf(request: ApiRequest, callers: Callers): CallStanding | undefined {
  const principal = request.principal;
  if (principal?.kind === 'device') {
    const base = deviceStanding(principal.holder, callers.device.grants, callers.device.stepUp);
    return {
      ...base,
      governance: {
        governed: true,
        decide: () => ({ allowed: true, refusal: 'granted' }),
      } as CallStanding['governance'],
      claimFreshStepUp: ((act: string) => {
        const granted = callers.fresh.delete(act);
        callers.claims.push({ act, granted });
        return granted;
      }) as CallStanding['claimFreshStepUp'],
    };
  }
  if (principal !== undefined) return undefined;
  if (request.arrival.kind !== 'local') return undefined;
  // The test host's arrival: a ferret is the privileged local caller, the owner the plain one.
  return request.arrival.privileged ? ferretStanding('F1936' as FerretId) : ownerStanding('ui');
}

/**
 * Gate's StandInAdmission for the main table, and for the member table a stand-in that decides NOTHING but who the
 * principal is: Gate's real `admitMember` is not on rebuild/5.0 yet, and a stand-in that refused a locked or gone
 * key itself would hide whether Catalogs' own handlers do. So every member row test below proves Catalogs.
 */
class CatalogsAdmission implements Admission {
  readonly #main: StandInAdmission;
  constructor(
    private readonly callers: Callers,
    private readonly provider: () => CredentialProvider | undefined,
    private readonly now: () => Instant,
  ) {
    this.#main = new StandInAdmission(request => standingOf(request, callers));
  }

  admit(input: AdmissionInput & { readonly table: 'route' | 'socket' | 'tool' }): AdmissionDecision {
    return this.#main.admit(input);
  }

  readmit(_request: ApiRequest, _descriptor: ScopedRoute): boolean {
    return this.#main.readmit();
  }

  inventory(request: ApiRequest, entries: readonly InventoryEntry[]): readonly InventoryEntry[] {
    return this.#main.inventory(request, entries);
  }

  admitMember(input: AdmissionInput & { readonly table: 'member' }): AdmissionDecision<MemberStanding> {
    const principal = input.request.principal;
    if (principal?.kind !== 'member')
      return { outcome: 'refused', response: errorResponse(403, 'Member routes are for members.', 'forbidden') };
    this.callers.memberAdmissions.push({ path: input.request.path, session: principal.session });
    const member = this.provider()?.standing(principal.holder, this.now());
    return {
      outcome: 'admitted',
      standing: { principal, member, session: principal.session } as unknown as MemberStanding,
      actor: 'owner-tools',
    };
  }
}

export interface CatalogsHalf {
  readonly routes: Record<string, (call: never) => Promise<ApiResponse>>;
  readonly memberRoutes: Record<string, (call: never) => Promise<ApiResponse>>;
  readonly hooks: {
    readonly 'credentials:member': CredentialProvider;
    readonly 'step-up:member': StepUpWitness;
    readonly 'session.modes:member': SessionMode;
  };
}

export interface CatalogsFixtureOptions {
  /** What Connections advertises; `undefined` = Connections is off. */
  readonly advertisement?: ConnectionAdvertisement | undefined;
  readonly carriers?: PublishedCarriers;
  /** Gate's settings; `undefined` = undetermined. */
  readonly memberUnlockDays?: number;
  /** Leave the `member` mode out of the session layer (a daemon with no bound member side). */
  readonly noMemberMode?: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly fetch?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  /** MCP servers the MCP item provider lists; absent = MCP is off. */
  readonly mcp?: McpSourceServer[];
}

/**
 * The MCP plugin as Catalogs meets it: one `catalog.items:mcp` provider over servers the test edits. Reading the
 * inventory is all an item needs to be frozen; installing into a runtime or a project is refused here.
 */
export function mcpItems(servers: McpSourceServer[]) {
  const refuse = async (): Promise<never> => {
    throw new Error('the test MCP provider installs nothing');
  };
  const provider: CatalogMcpProvider = {
    kind: 'mcp',
    sources: async () => servers,
    projectRoots: async () => [],
    project: { read: refuse, replace: refuse } as never,
    runtime: {
      runtimes: async () => ({ runtimes: [] }),
      profiles: async () => ({ profiles: [] }),
      storedComponent: refuse,
      propose: refuse,
      apply: refuse,
      installCatalogItem: refuse,
    },
  };
  const manifest = definePlugin({
    id: 'mcp',
    title: 'MCP',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: ['item'],
    hooks: { takes: [{ hook: CatalogItems, key: 'mcp' }] },
  });
  return implementDaemon(manifest, { build: () => ({ hooks: { 'catalog.items:mcp': provider } }) as never });
}

/** An MCP component server, the one kind whose harness a shared item carries. */
export const mcpServer = (name: string, args: readonly string[] = ['-y', name]): McpSourceServer => ({
  id: `id-component-${name}`,
  name,
  scope: 'component',
  harness: 'claude',
  declaration: null,
  component: { command: 'npx', args, env: {}, harness: 'claude' },
});

export const LOOPBACK_ADVERTISEMENT: ConnectionAdvertisement = {
  advertisement: { kind: 'local-only', url: LOOPBACK_URL },
  discoveredRelayUrl: DISCOVERED_RELAY,
  port: 4141,
  appOrigin: APP_ORIGIN,
  allowedOrigins: [APP_ORIGIN],
};

export interface CatalogsFixture {
  readonly host: TestHost;
  readonly half: CatalogsHalf;
  readonly clock: DrivenClock;
  readonly daemonId: string;
  readonly gate: FakeGate;
  readonly vault: FakeVault;
  readonly callers: Callers;
  readonly verifier: ReturnType<typeof acceptingVerifier>;
  readonly dispatcher: Dispatcher;
  readonly layer: session.SessionLayerHost;
  /** Every request the session layer handed the kernel's dispatcher. */
  readonly dispatched: ApiRequest[];
  /** Turn Connections off (or back on) after build. */
  setAdvertisement(next: ConnectionAdvertisement | undefined): void;
  /** Open one session on a carrier, as a carrier would. */
  open(carrier?: string, peer?: CarrierPeer): BrowserEnd;
}

export async function catalogsFixture(options: CatalogsFixtureOptions = {}): Promise<CatalogsFixture> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const pem = toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const kernelIdentity = await kernelCrypto.importDaemonIdentity(pem);
  const wireIdentity = await wireCrypto.importDaemonIdentity(pem);
  if (kernelIdentity.daemonId !== wireIdentity.daemonId) throw new Error('one key, one daemon id');
  const signer: CatalogSigningIdentity['signer'] = {
    signCatalog: async ({ kind, canonical }) => {
      const digest = await wireCrypto.sha256(canonical);
      const message =
        kind === 'manifest'
          ? catalogManifestSignedBytes(digest)
          : kind === 'versions'
            ? catalogVersionsSignedBytes(digest)
            : catalogLinkSignedBytes(digest);
      return {
        daemonId: wireIdentity.daemonId,
        publicKey: toBase64Url(wireIdentity.publicKeySpki),
        signature: toBase64Url(await wireCrypto.signEd25519(wireIdentity.privateKey, message)),
      };
    },
  };
  const clock = fixedClock(START);
  const gate = new FakeGate();
  if (options.memberUnlockDays !== undefined) {
    const policy = gate.policy();
    if (policy !== undefined)
      gate.setPolicy({
        ...policy,
        security: { ...policy.security, memberUnlockDays: options.memberUnlockDays } as never,
      });
  }
  const vault = new FakeVault();
  const verifier = acceptingVerifier();
  const access = fakeAccess({ passkeys: verifier });
  let advertisement = 'advertisement' in options ? options.advertisement : LOOPBACK_ADVERTISEMENT;
  const connections = Object.assign(fakeConnections(options.carriers ?? [{ kind: 'direct', url: LOOPBACK_URL }]), {
    advertisement: () => advertisement,
  });
  const callers: Callers = {
    device: { grants: FULL_DEVICE_GRANTS, stepUp: false },
    fresh: new Set(),
    claims: [],
    memberAdmissions: [],
  };
  let half: CatalogsHalf | undefined;
  const admission = new CatalogsAdmission(
    callers,
    () => half?.hooks['credentials:member'],
    () => clock.now(),
  );
  const composed = {
    ...catalogsDaemon,
    build: (ctx: Parameters<NonNullable<typeof catalogsDaemon.build>>[0]) => {
      const built = catalogsDaemon.build?.({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          state: opaqueAsBytes(ctx.kernel.state),
          identity: { daemonId: wireIdentity.daemonId, daemonName: 'Publisher' },
          signer,
        } as typeof ctx.kernel,
      });
      half = built as unknown as CatalogsHalf;
      return built as NonNullable<typeof built>;
    },
  };
  const host = await testHost({
    plugins: [...(options.mcp === undefined ? [] : [mcpItems(options.mcp) as never]), composed as never],
    fakes: { access, gate, vault, sealed: new FakeSealedDocuments() },
    uses: { connections },
    gate: admission,
    clock,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (half === undefined) throw new Error('the Catalogs half was not built');
  const built = half;
  const owner = { plugin: 'catalogs' as never, title: manifest.title, serving: () => ({ kind: 'serving' }) as const };
  const dispatcher = new Dispatcher(
    { admission: () => admission, outputGuard: () => undefined, version: manifest.version },
    {
      routes: manifest.actions.routes.map(
        route => ({ ...route, owner, handle: built.routes[route.key] }) as unknown as MountedRoute,
      ),
      sockets: [],
      memberRoutes: manifest.actions.memberRoutes.map(
        route => ({ ...route, owner, handle: built.memberRoutes[route.key] }) as unknown as MountedMemberRoute,
      ),
    },
  );
  const dispatched: ApiRequest[] = [];
  const layer = session.createSessionLayer({
    crypto: kernelCrypto,
    identity: { ...kernelIdentity, sign: session.signingKey(kernelCrypto, kernelIdentity).sign },
    modes: key => (key === 'member' && options.noMemberMode !== true ? built.hooks['session.modes:member'] : undefined),
    dispatch: async request => {
      dispatched.push(request);
      return await dispatcher.dispatch(request);
    },
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    clock: clock as never,
  });
  // Load the member projection, as the boot job does.
  await host.runJob('catalogs-load-members');
  return {
    host,
    half: built,
    clock,
    daemonId: wireIdentity.daemonId,
    gate,
    vault,
    callers,
    verifier,
    dispatcher,
    layer,
    dispatched,
    setAdvertisement: next => {
      advertisement = next;
    },
    open: (carrier = 'relay', peer) => {
      const link = layer.open(carrier as CarrierKey, peer);
      return new BrowserEnd(link, wireIdentity.daemonId);
    },
  };
}

/**
 * TODO(kernel testing): the real host keeps an `opaque` file as the bytes written and reads them back as bytes
 * (`host/state/state-port.ts`: writeAtomic, readBytesFile); the test host's MemoryStateFolder stamps the value into a
 * JSON object (a string is spread into its characters). Catalogs is written against the real host, so the fixture
 * keeps opaque files as the real host does; the write still goes through the test host, so a simulated crash bites.
 */
function opaqueAsBytes(state: StatePort): StatePort {
  const bytes = new Map<string, Uint8Array>();
  const key = (file: { readonly path: string }, name?: string) => `${file.path}\u0000${name ?? ''}`;
  return {
    ...state,
    read: async (file, name) => {
      if (file.store !== 'opaque') return await state.read(file, name);
      const result = await state.read(file, name);
      if (!result.ok) return result;
      const held = bytes.get(key(file, name));
      return { ok: true, value: held === undefined ? undefined : held.slice() } as typeof result;
    },
    write: async (file, value, name) => {
      if (file.store === 'opaque')
        bytes.set(
          key(file, name),
          typeof value === 'string' ? new TextEncoder().encode(value) : (value as Uint8Array).slice(),
        );
      await state.write(file, file.store === 'opaque' ? ({} as never) : value, name);
    },
  } as StatePort;
}

// ─── the owner's side, through the test host ─────────────────────────────────────────────────────────────────────

export async function makeCatalog(fx: CatalogsFixture, name = 'Team'): Promise<string> {
  const made = await fx.host.request('POST', '/v1/catalogs', { body: { name } });
  if (made.status !== 201) throw new Error(`catalog: ${made.status} ${made.body}`);
  return made.json<{ id: string }>().id;
}

export interface MintOptions {
  readonly catalogIds: readonly string[];
  readonly member?: { kind: 'new'; label: string } | { kind: 'existing'; memberId: string };
  readonly uses?: { kind: 'single' } | { kind: 'multi'; cap: number };
  readonly newPasskey?: boolean;
  readonly expiresIn?: '15m' | '1h' | '3h' | '8h' | '1d';
}

let mintCount = 0;
export async function mintShare(
  fx: CatalogsFixture,
  mint: MintOptions,
): Promise<{ code: string; shareId: string; body: Record<string, unknown> }> {
  const minted = await fx.host.request('POST', '/v1/catalog-shares', {
    body: {
      catalogIds: mint.catalogIds,
      member: mint.member ?? { kind: 'new', label: `Member ${String(++mintCount)}` },
      expiresIn: mint.expiresIn ?? '1h',
      uses: mint.uses ?? { kind: 'single' },
      ...(mint.newPasskey === undefined ? {} : { newPasskey: mint.newPasskey }),
    },
  });
  if (minted.status !== 201) throw new Error(`share: ${minted.status} ${minted.body}`);
  const body = minted.json<Record<string, unknown>>();
  const share = body.share as { id?: string; shareId?: string } | undefined;
  return { code: String(body.code), shareId: String(share?.id ?? share?.shareId ?? body.shareId), body };
}

// ─── the browser's side ──────────────────────────────────────────────────────────────────────────────────────────

const settle = async (rounds = 20): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve));
};

export const BOX_KEY = toBase64Url(new Uint8Array(32).fill(7));
export const CLIENT_NAME = 'Firefox on a Mac';

/** A browser's member key pair. */
export interface Browser {
  readonly memberKey: string;
  readonly privateKey: CryptoKey;
  readonly appSession: string;
}

export async function browser(): Promise<Browser> {
  const key = await kernelCrypto.generateDeviceKey();
  return {
    memberKey: session.toBase64Url(key.publicKeySpki),
    privateKey: key.privateKey,
    appSession: session.toBase64Url(kernelCrypto.randomBytes(16)),
  };
}

/** One received record: its parsed shape and its plaintext size. */
export interface Received {
  readonly message: Record<string, unknown>;
  readonly bytes: number;
  readonly text: string;
}

/** The browser's end of one session over one carrier link: hs1/hs2, then sealed records, as the app speaks them. */
export class BrowserEnd {
  readonly records: Received[] = [];
  /** Every frame's bytes as the carrier (and so a relay) saw them. */
  readonly wire: Uint8Array[] = [];
  end: SessionEnd | undefined;
  #channel: session.ChannelState | undefined;
  #transcript: Uint8Array | undefined;
  #hello: session.SessionFrame | undefined;
  readonly #sessionId: session.SessionId;

  constructor(
    readonly link: CarrierLink,
    readonly daemonId: string,
  ) {
    const id = session.sessionIdFromBytes(kernelCrypto.randomBytes(16));
    if (id === null) throw new Error('session id');
    this.#sessionId = id;
  }

  get transcript(): Uint8Array {
    if (this.#transcript === undefined) throw new Error('not keyed');
    return this.#transcript;
  }

  async handshake(): Promise<this> {
    const pending = await session.startClientHandshake(kernelCrypto, this.#sessionId, this.daemonId);
    this.#deliver(
      session.encodeFrame({
        kind: session.FRAME_KINDS.handshake,
        sessionId: this.#sessionId,
        sequence: 0,
        payload: session.utf8Bytes(JSON.stringify(pending.hello)),
      }),
    );
    await this.pump();
    const frame = this.#hello;
    if (frame === undefined) throw new Error('no daemon hello');
    const hello = session.decodeDaemonHello(frame.payload);
    if (hello === null) throw new Error('daemon hello unreadable');
    const done = await session.completeClientHandshake(kernelCrypto, pending, hello);
    if (!done.ok) throw new Error(done.reason);
    this.#channel = session.openChannel(this.#sessionId, done.keys, 'client');
    this.#transcript = done.keys.transcriptHash;
    return this;
  }

  #deliver(bytes: Uint8Array): void {
    this.wire.push(Uint8Array.from(bytes));
    this.link.inbound(bytes);
  }

  async send(record: Record<string, unknown>): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) throw new Error('not keyed');
    const sealed = await session.sealRecord(kernelCrypto, channel, session.utf8Bytes(JSON.stringify(record)));
    if (!sealed.ok) throw new Error(sealed.reason);
    this.#channel = sealed.state;
    this.#deliver(session.encodeFrame(sealed.frame));
  }

  async sign(who: Browser, message: Uint8Array): Promise<string> {
    return await session.signDeviceProof(kernelCrypto, kernelCrypto.deviceKeyHandle(who.privateKey), message);
  }

  async join(who: Browser, code: string, extra: Record<string, unknown> = {}): Promise<void> {
    const proof = await this.sign(who, session.memberJoinMessage(this.transcript, who.memberKey, BOX_KEY));
    await this.send({
      t: 'join',
      protocol: session.SESSION_PROTOCOL_ID,
      code,
      clientName: CLIENT_NAME,
      memberKey: who.memberKey,
      boxKey: BOX_KEY,
      proof,
      ...extra,
    });
    await this.pump();
  }

  async joinOptions(who: Browser, code: string, origin = APP_ORIGIN, signer: Browser = who): Promise<void> {
    const proof = await this.sign(signer, session.memberJoinOptionsMessage(this.transcript, who.memberKey, origin));
    await this.send({
      t: 'join-options',
      protocol: session.SESSION_PROTOCOL_ID,
      code,
      memberKey: who.memberKey,
      origin,
      proof,
    });
    await this.pump();
  }

  async member(who: Browser, keyId: string, signer: Browser = who): Promise<void> {
    const proof = await this.sign(signer, session.memberAuthMessage(this.transcript, keyId, who.appSession));
    await this.send({ t: 'member', protocol: session.SESSION_PROTOCOL_ID, keyId, appSession: who.appSession, proof });
    await this.pump();
  }

  #nextId = 1;
  /** One request on a serving session and its answer. */
  async ask(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> & { code?: string } }> {
    const id = this.#nextId++;
    await this.send({
      t: 'req',
      id,
      method,
      path,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    await this.pump();
    const answer = this.records.find(entry => entry.message.t === 'res' && entry.message.id === id)?.message;
    if (answer === undefined)
      throw new Error(`no answer to ${method} ${path}${this.end === undefined ? '' : ` (ended ${this.end.code})`}`);
    const res = answer as { status: number; headers?: Record<string, string>; body: string };
    const parsed = res.body === '' ? {} : (JSON.parse(res.body) as Record<string, unknown>);
    const error = parsed.error;
    const code =
      typeof parsed.code === 'string'
        ? parsed.code
        : typeof error === 'object' && error !== null
          ? (error as { code?: string }).code
          : undefined;
    return {
      status: res.status,
      headers: res.headers ?? {},
      body: { ...parsed, ...(code === undefined ? {} : { code }) },
    };
  }

  /** Pull everything the daemon has queued for this end, until it is quiet. */
  async pump(): Promise<void> {
    let idle = 0;
    while (idle < 6 && this.end === undefined) {
      await settle(4);
      let pulled = false;
      for (let next = this.link.outbound.next(); next !== undefined; next = this.link.outbound.next()) {
        if (isSessionEnd(next)) {
          this.end = next;
          return;
        }
        pulled = true;
        await this.#receive(next.bytes);
      }
      if (pulled) idle = 0;
      else {
        idle += 1;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
  }

  #window = session.newReceiveWindow();

  /** The browser returns credit once half a window is owed, as the app's channel does (R96). */
  #credit(): void {
    if (this.end !== undefined) return;
    const owed = session.creditToReturn(this.#window);
    if (owed === 0) return;
    this.#window = session.recordCredited(this.#window, owed);
    this.link.inbound(
      session.encodeFrame({
        kind: session.FRAME_KINDS.credit,
        sessionId: this.#sessionId,
        sequence: 0,
        payload: session.encodeCreditPayload(owed),
      }),
    );
  }

  async #receive(bytes: Uint8Array): Promise<void> {
    this.wire.push(Uint8Array.from(bytes));
    const decoded = session.decodeFrame(bytes);
    if (!decoded.ok) throw new Error(decoded.reason);
    const frame = decoded.frame;
    if (frame.kind === session.FRAME_KINDS.handshake) {
      this.#hello = frame;
      return;
    }
    if (frame.kind !== session.FRAME_KINDS.data) return;
    const channel = this.#channel;
    if (channel === undefined) throw new Error('record before keys');
    const opened = await session.openRecord(kernelCrypto, channel, frame);
    if (!opened.ok) throw new Error(opened.reason);
    this.#channel = opened.state;
    this.#window = session.recordConsumed(this.#window);
    this.#credit();
    const text = session.utf8Text(opened.plaintext) ?? '';
    this.records.push({ message: JSON.parse(text) as Record<string, unknown>, bytes: opened.plaintext.length, text });
  }

  last(t: string): Received | undefined {
    return [...this.records].reverse().find(record => record.message.t === t);
  }
}

/** Joins with a fresh session and answers the `joined` response (or throws). */
export async function joinWith(
  fx: CatalogsFixture,
  who: Browser,
  code: string,
  carrier = 'relay',
): Promise<
  { keyId: string; memberId: string; catalogCount: number; passkeyWindowEndsAt: string } & Record<string, unknown>
> {
  const end = await fx.open(carrier).handshake();
  await end.join(who, code);
  const outcome = end.records[0]?.message;
  if (outcome?.t !== 'joined')
    throw new Error(
      `join: ${JSON.stringify(outcome)} end=${JSON.stringify(end.end)} records=${end.records.length} logs=${JSON.stringify(fx.host.logs)} report=${JSON.stringify(fx.layer.report())}`,
    );
  return outcome.response as never;
}

/** A serving member session for a joined key. */
export async function memberSession(
  fx: CatalogsFixture,
  who: Browser,
  keyId: string,
  carrier = 'relay',
): Promise<BrowserEnd> {
  const end = await fx.open(carrier).handshake();
  await end.member(who, keyId);
  return end;
}

const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString('base64url');

/** Registers the key's one passkey in its window and unlocks, as the app does. */
export async function unlock(end: BrowserEnd): Promise<void> {
  const credentialId = b64(CREDENTIAL);
  const options = await end.ask('POST', '/v1/shared/passkeys/options', { origin: APP_ORIGIN });
  if (options.status !== 200) throw new Error(`passkey options ${options.status} ${JSON.stringify(options.body)}`);
  const registered = await end.ask('POST', '/v1/shared/passkeys', {
    credentialId,
    clientDataJSON: b64('client'),
    attestationObject: b64('attestation'),
  });
  if (registered.status !== 201) throw new Error(`passkey ${registered.status} ${JSON.stringify(registered.body)}`);
  await unlockOnly(end);
}

export async function unlockOnly(end: BrowserEnd): Promise<{ status: number; body: Record<string, unknown> }> {
  const opened = await end.ask('POST', '/v1/shared/unlock/options', { origin: APP_ORIGIN });
  if (opened.status !== 200) return opened;
  return await end.ask('POST', '/v1/shared/unlock', {
    credentialId: b64(CREDENTIAL),
    clientDataJSON: b64('client'),
    authenticatorData: b64('authenticator'),
    signature: b64('signature'),
  });
}

export type { HolderId };
