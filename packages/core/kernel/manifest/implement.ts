import type { Duration, Instant, JsonValue, Result } from '@ferretry/std';
import type {
  ApiOf,
  ContributeHook,
  Contribution,
  DecideHook,
  EventDef,
  HookDecision,
  HookHandlerOf,
  ObserveHook,
  PayloadOf,
  PortToken,
  ProvideHook,
  TransformHook,
} from '../contract/define.ts';
import type { DoctorFinding } from '../contract/kernel.ts';
import type { Cancel, KernelPorts, StatePort } from '../contract/ports.ts';
import type { CallContext, MemberRouteHandler, RouteHandler } from '../contract/route.ts';
import type { SocketAccept } from '../contract/socket.ts';
import type { Manifest, Needer } from './types.ts';

// ─── reading a manifest's literals ────────────────────────────────────────────────────────────────────────────────

type Actions<M> = M extends { readonly actions: infer A } ? A : {};
type Ui<M> = M extends { readonly ui: infer U } ? U : {};
type Data<M> = M extends { readonly data: infer D } ? D : {};
type Hooks<M> = M extends { readonly hooks: infer H } ? H : {};
type Elem<T, K extends string> = T extends { readonly [P in K]: readonly (infer E)[] } ? E : never;

type Field<E, F extends string> = E extends { readonly [P in F]: infer V extends string } ? V : never;

export type RouteKeysOf<M> = Field<Elem<Actions<M>, 'routes'>, 'key'>;
export type SocketKeysOf<M> = Field<Elem<Actions<M>, 'sockets'>, 'key'>;
export type MemberRouteKeysOf<M> = Field<Elem<Actions<M>, 'memberRoutes'>, 'key'>;
export type ToolNamesOf<M> = Field<Elem<Actions<M>, 'agentTools'>, 'name'>;
export type VerbsOf<M> = Field<Elem<Actions<M>, 'cli'>, 'verb'>;
export type ScreenIdsOf<M> = Field<Elem<Ui<M>, 'screens'>, 'id'>;
export type PanelIdsOf<M> = Field<Elem<Ui<M>, 'panels'>, 'id'>;
export type SettingsIdsOf<M> = Field<Elem<Ui<M>, 'settings'>, 'id'>;
export type RendererKeysOf<M> = Field<Elem<Ui<M>, 'renderers'>, 'key'>;
export type SubscribesOf<M> = Elem<Data<M>, 'subscribes'>;
export type TakesOf<M> = Elem<Hooks<M>, 'takes'>;
export type DoctorIdsOf<M> = M extends { readonly doctor: readonly (infer D extends string)[] } ? D : never;
type NetworkEntryOf<M> = M extends { readonly permissions: { readonly network: readonly (infer E)[] } } ? E : never;
export type ResolverIdsOf<M> =
  NetworkEntryOf<M> extends infer E ? (E extends { readonly resolver: infer R extends string } ? R : never) : never;

type TokensOf<M, K extends 'needs' | 'uses' | 'provides'> = M extends { readonly [P in K]: infer T } ? T : {};

/** `needs: { asks: AsksPort }` → `{ asks: AsksApi }`. */
export type PortsOf<T> = { readonly [K in keyof T]: ApiOf<T[K]> };

const PER_NEEDER: unique symbol = Symbol('fy.per-needer');

/**
 * A `provides` entry built once for EACH plugin that needs or uses it, instead of one value shared by all (§3.7):
 * the kernel calls `build` with that plugin's id and effective permissions the first time it binds the port for it,
 * and hands the same answer to it ever after. Mark one with {@link perNeeder}; a plain value is shared, as before.
 */
export interface PerNeeder<Api> {
  readonly [PER_NEEDER]: (needer: Needer) => Api;
}

/** A per-needer `provides` entry: `provides: { vault: perNeeder(needer => apiFor(needer)) }`. */
export function perNeeder<Api>(build: (needer: Needer) => Api): PerNeeder<Api> {
  return Object.freeze({ [PER_NEEDER]: build });
}

/** Whether a provided value is a {@link perNeeder} factory rather than a shared value. */
export function isPerNeeder(value: unknown): value is PerNeeder<unknown> {
  return typeof value === 'object' && value !== null && PER_NEEDER in value;
}

/** The value a needer is handed: a shared value as it is, a {@link PerNeeder} built for that needer. */
export function providedFor(value: unknown, needer: Needer): unknown {
  return isPerNeeder(value) ? value[PER_NEEDER](needer) : value;
}

/** `provides: { vault: VaultPort }` → `{ vault: VaultApi | PerNeeder<VaultApi> }`. */
export type ProvidedOf<T> = { readonly [K in keyof T]: ApiOf<T[K]> | PerNeeder<ApiOf<T[K]>> };

/**
 * An optional port (§7.6 step 5): unbound during `build` (calling `current()` there throws); from `started` on it is
 * the provider's port, or `undefined` when that plugin is off.
 */
export interface UsesHandle<Api> {
  current(): Api | undefined;
}
export type UsesOf<T> = { readonly [K in keyof T]: UsesHandle<ApiOf<T[K]>> };

type TakeKey<T> = T extends {
  readonly hook: ProvideHook<infer N, string, unknown>;
  readonly key: infer K extends string;
}
  ? `${N}:${K}`
  : T extends { readonly hook: { readonly name: infer N extends string } }
    ? N
    : never;

/** One implementation per taken hook, keyed `name` (or `name:key` for a provide hook). */
export type HookImplsOf<M> = {
  readonly [T in TakesOf<M> as TakeKey<T>]: HookHandlerOf<T extends { readonly hook: infer H } ? H : never>;
};

export type SubscribersOf<M> = {
  readonly [E in SubscribesOf<M> as E extends EventDef<infer N, unknown> ? N : never]: (
    payload: PayloadOf<E>,
  ) => void | Promise<void>;
};

/** A required section when the manifest declares something in it; optional (and empty) when it declares nothing. */
type Section<Name extends string, T> = [keyof T] extends [never]
  ? { readonly [P in Name]?: T }
  : { readonly [P in Name]: T };

// ─── daemon half ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Invokes a hook THIS plugin offers (the kernel refuses one it did not declare in `hooks.offers`). */
export interface HookInvoker {
  observe<P>(hook: ObserveHook<string, P>, payload: P): void;
  decide<I>(hook: DecideHook<string, I>, input: I): Promise<HookDecision>;
  transform<V>(hook: TransformHook<string, V>, value: V): Promise<Result<V, string>>;
  provider<K extends string, V>(hook: ProvideHook<string, K, V>, key: K): V | 'unavailable';
  /** The declaring plugin id, even when off, failed or skeleton; undefined when nobody declares that key. */
  declaredProvider<K extends string, V>(hook: ProvideHook<string, K, V>, key: K): string | undefined;
  providers<K extends string, V>(hook: ProvideHook<string, K, V>): ReadonlyMap<K, V>;
  contributions<I>(hook: ContributeHook<string, I>): readonly Contribution<I>[];
}

/** What `build` receives: its declared needs, unbound `uses` handles, the kernel ports, and its offered hooks. */
export interface DaemonContext<M extends Manifest> {
  readonly manifest: M;
  readonly needs: PortsOf<TokensOf<M, 'needs'>>;
  readonly uses: UsesOf<TokensOf<M, 'uses'>>;
  readonly kernel: KernelPorts;
  readonly hooks: HookInvoker;
}

/** An agent tool's answer (MCP). Text already masked; never a secret. */
export interface ToolResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly data?: JsonValue;
}

export type ToolHandler = (call: CallContext, input: unknown) => Promise<ToolResult>;

/** A declared network resolver: the hosts it allows right now, from the plugin's own config/state only. */
export type NetworkResolver = () => readonly string[];

/** One declared `fy doctor` check: reads only the plugin's own ports; never a secret in `detail` or `fix`. */
export type DoctorRun = () => Promise<DoctorFinding>;

/** What `build` returns: one implementation for everything the manifest declares, nothing more (`manifest-match`). */
export type DaemonHalf<M extends Manifest> = Section<'routes', { readonly [K in RouteKeysOf<M>]: RouteHandler }> &
  Section<'sockets', { readonly [K in SocketKeysOf<M>]: SocketAccept }> &
  Section<'memberRoutes', { readonly [K in MemberRouteKeysOf<M>]: MemberRouteHandler }> &
  Section<'tools', { readonly [K in ToolNamesOf<M>]: ToolHandler }> &
  Section<'provides', ProvidedOf<TokensOf<M, 'provides'>>> &
  Section<'hooks', HookImplsOf<M>> &
  Section<'subscribers', SubscribersOf<M>> /**
   * A declared check with no run still boots: `fy doctor` reports it as a failure that names it (`has no
   * implementation`), so a missing check is seen, never silent. A run for an undeclared id is refused.
   */ & { readonly doctor?: { readonly [K in DoctorIdsOf<M>]?: DoctorRun } } & Section<
    'resolvers',
    { readonly [K in ResolverIdsOf<M>]: NetworkResolver }
  > & {
    /** Once per boot after state and ports are ready, under the home lock, before listeners. Best effort; at most 5 seconds. */
    readonly beforeListen?: (ctx: DaemonContext<M>) => Promise<void>;
  };

export interface DaemonImplementation<M extends Manifest = Manifest> {
  readonly half: 'daemon';
  readonly manifest: M;
  /** Synchronous, in start order (§7.6 step 4). Async set-up belongs in a job. Absent on a skeleton. */
  readonly build?: (ctx: DaemonContext<M>) => DaemonHalf<M>;
  /** A day-1 skeleton: every declared route answers `503 plugin_unavailable`; allowed only while in ports-pending. */
  readonly skeleton?: true;
}

export function implementDaemon<const M extends Manifest>(
  manifest: M,
  spec: { readonly build: (ctx: DaemonContext<M>) => DaemonHalf<M> },
): DaemonImplementation<M> {
  return Object.freeze({ half: 'daemon', manifest, build: spec.build });
}

// ─── app half ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One open socket route, from the plugin's side (the app shell's `TransportSocket`). */
export interface PluginSocket {
  send(frame: string | Uint8Array): void;
  /** Leave on purpose; the code and reason travel to the daemon. */
  close(code?: number, reason?: string): void;
}

/** The event feed's liveness, from the plugin's side (the app shell's `DaemonClient.feed`). */
export interface PluginFeed {
  isLive(): boolean;
  /** Told whenever the feed goes live or drops. Returns a cancel. */
  subscribeLive(listener: (live: boolean) => void): Cancel;
}

/** What a plugin hears on a socket route (the app shell's `SocketListeners`). */
export interface PluginSocketListeners {
  /** The daemon accepted the stream: from here a frame sent reaches it (a frame sent before is dropped). */
  readonly onOpen?: () => void;
  readonly onFrame: (frame: string | Uint8Array) => void;
  /** The stream ended; `code` is the close code it ended with (`1008` is a refusal, not a drop), absent if it never opened. */
  readonly onClose: (reason: string, code?: number) => void;
}

/**
 * The only headers a half may set on a call (lead decision 7): today's idempotency id for a move or a fork, and the
 * agenda channel (`2`: an agenda list read asks for resolved records as headers). A closed list the shell checks; a
 * channel value other than `2` is dropped. Anything else is the shell's (credentials, the contract hash).
 */
export interface PluginCallHeaders {
  readonly 'x-fy-request-id'?: string;
  readonly 'x-fy-agenda-channel'?: '2';
}

/** `PluginClient.conditional`'s request: the etag the caller holds, and the same allow-listed headers as `call`. */
export interface PluginConditionalInit {
  readonly ifNoneMatch?: string;
  readonly headers?: PluginCallHeaders;
}

/** A conditional read's answer: the body with its etag, or `304` when the held etag is still current. */
export type PluginConditionalAnswer =
  | { readonly status: 200; readonly etag?: string; readonly body: unknown }
  | { readonly status: 304; readonly etag?: string };

/** The per-daemon generated client a half talks through (§9.6). It checks the plugin's inventory entry first. */
export interface PluginClient {
  call<Answer = unknown>(
    route: string,
    init?: {
      readonly params?: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      /** Allow-listed (`PluginCallHeaders`), through the same contract-hash guard as the call. */
      readonly headers?: PluginCallHeaders;
    },
  ): Promise<Answer>;
  subscribe<Name extends string, Payload>(event: EventDef<Name, Payload>, listener: (payload: Payload) => void): Cancel;
  /**
   * A guarded duplex socket route (F2): `key` is a socket the manifest (or a contract it imports) declares, opened
   * through the same contract-hash guard as `call`. Optional until the app shell and the CLI fill it in.
   */
  socket?(key: string, params: Readonly<Record<string, string>>, listeners: PluginSocketListeners): PluginSocket;
  /**
   * Whether the daemon's event feed (what `subscribe` hears) is live, and when that changes. A screen that polls
   * beside the feed polls slowly while it is live and at its own pace when it is not. Optional until the app shell
   * fills it in.
   */
  feed?: PluginFeed;
  /**
   * A conditional GET (today's per-connection etag/304 list read, the held fleet list R502): sends `If-None-Match`
   * and answers `304` without a body when it still matches. Optional until the app shell and the CLI fill it in.
   */
  conditional?(
    key: string,
    params: Readonly<Record<string, string>>,
    init?: PluginConditionalInit,
  ): Promise<PluginConditionalAnswer>;
}

/** A UI component, framework-neutral here; the app shell narrows it to React. */
export type AppComponent<Props> = (props: Props) => unknown;

export interface ScreenProps {
  readonly params: Readonly<Record<string, string | undefined>>;
}
export interface PanelProps {
  readonly subject?: string;
}
export type SettingsProps = {};
export interface RendererProps {
  readonly value: unknown;
}

export interface AppContext<M extends Manifest> {
  readonly manifest: M;
  readonly client: PluginClient;
}

export type AppHalf<M extends Manifest> = Section<
  'screens',
  { readonly [K in ScreenIdsOf<M>]: AppComponent<ScreenProps> }
> &
  Section<'panels', { readonly [K in PanelIdsOf<M>]: AppComponent<PanelProps> }> &
  Section<'settings', { readonly [K in SettingsIdsOf<M>]: AppComponent<SettingsProps> }> &
  Section<'renderers', { readonly [K in RendererKeysOf<M>]: AppComponent<RendererProps> }>;

export interface AppImplementation<M extends Manifest = Manifest> {
  readonly half: 'app';
  readonly manifest: M;
  readonly build?: (ctx: AppContext<M>) => AppHalf<M>;
  readonly skeleton?: true;
}

export function implementApp<const M extends Manifest>(
  manifest: M,
  spec: { readonly build: (ctx: AppContext<M>) => AppHalf<M> },
): AppImplementation<M> {
  return Object.freeze({ half: 'app', manifest, build: spec.build });
}

// ─── CLI half ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TerminalIo {
  out(text: string): void;
  err(text: string): void;
  readonly isTty: boolean;
}

export interface VerbInvocation {
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | readonly string[]>>;
}

/**
 * The environment a CLI half may read (lead decision 21): `FY_SESSION_ID` and the names the fy shell allows, and
 * nothing else; a name the shell does not pass reads `undefined`.
 */
export type CliEnvironment = Readonly<Partial<Record<string, string>>>;

export interface CliContext<M extends Manifest> {
  readonly manifest: M;
  readonly client: PluginClient;
  readonly io: TerminalIo;
  /**
   * UTF-8 text from a path (relative to the CLI working directory); '-' reads stdin.
   * As today's readRecipe (Bun.file/Bun.stdin.text): no reader size cap. The caller validates length
   * (a sign-in recipe, for example, must be 1–4000 characters).
   */
  readText?(path: string): Promise<string>;
  /**
   * Whether a path exists, resolved against the CLI working directory (never stdin: `-` is a file named `-`).
   * As today's `existsSync`: a directory counts, and so does a file that exists but cannot be read. It reads no
   * content, so a poll (`fy wait --until-marker`) costs one probe, not a whole-file read.
   */
  exists?(path: string): Promise<boolean>;
  /** Own declared opaque defs only; private directory operations and stat require named trees. Optional until fy supplies it. */
  readonly ownState?: Pick<
    StatePort,
    'write' | 'pathOf' | 'stat' | 'remove' | 'list' | 'removeEmptyDirectory' | 'createPrivateDirectory'
  >;
  /** The time, for a verb that reports or waits. Optional until the fy shell fills it in. */
  readonly clock?: { now(): Instant; nowMs(): number };
  /** Waits, cancellable (a poll loop). */
  sleep?(delay: Duration, signal?: AbortSignal): Promise<void>;
  /** `FY_SESSION_ID` and the shell's allowed names only. */
  readonly env?: CliEnvironment;
  /** Asks a question at the terminal; `undefined` when there is no terminal to ask at. */
  prompt?(question: string): Promise<string | undefined>;
  /** A yes/no at the terminal; `false` when there is no terminal. */
  confirm?(question: string): Promise<boolean>;
  /**
   * Reads a secret typed at the terminal without echoing it (Vault's CLI): the answer goes straight to the caller, is
   * never logged, never kept, never in a transcript. `undefined` when there is no terminal.
   */
  promptHidden?(question: string): Promise<string | undefined>;
}

/** Answers the exit code. */
export type VerbHandler = (invocation: VerbInvocation) => Promise<number>;

export type CliHalf<M extends Manifest> = Section<'verbs', { readonly [K in VerbsOf<M>]: VerbHandler }>;

export interface CliImplementation<M extends Manifest = Manifest> {
  readonly half: 'cli';
  readonly manifest: M;
  readonly build?: (ctx: CliContext<M>) => CliHalf<M>;
  readonly skeleton?: true;
}

export function implementCli<const M extends Manifest>(
  manifest: M,
  spec: { readonly build: (ctx: CliContext<M>) => CliHalf<M> },
): CliImplementation<M> {
  return Object.freeze({ half: 'cli', manifest, build: spec.build });
}

// ─── skeletons ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The day-1 skeleton halves (§10.3): they declare everything (the manifest) and implement nothing. The kernel answers
 * each declared route, socket and tool `503 plugin_unavailable`, treats each provide key as `unavailable`, each
 * decide/transform/observe/contribute take as a no-op the conformance suite marks `skeleton`; the CLI and app shells
 * show the skeleton sentence. `manifest-match` accepts a skeleton only while the plugin is in `ports-pending.json`.
 */
export function skeletonDaemon<const M extends Manifest>(manifest: M): DaemonImplementation<M> {
  return Object.freeze({ half: 'daemon', manifest, skeleton: true });
}
export function skeletonApp<const M extends Manifest>(manifest: M): AppImplementation<M> {
  return Object.freeze({ half: 'app', manifest, skeleton: true });
}
export function skeletonCli<const M extends Manifest>(manifest: M): CliImplementation<M> {
  return Object.freeze({ half: 'cli', manifest, skeleton: true });
}

export type { PortToken };
