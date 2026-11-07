import type { JsonValue, Result } from '@ferretry/std';
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
import type { Cancel, KernelPorts } from '../contract/ports.ts';
import type { CallContext, MemberRouteHandler, RouteHandler } from '../contract/route.ts';
import type { SocketAccept } from '../contract/socket.ts';
import type { Manifest } from './types.ts';

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

type TokensOf<M, K extends 'needs' | 'uses' | 'provides'> = M extends { readonly [P in K]: infer T } ? T : {};

/** `needs: { asks: AsksPort }` → `{ asks: AsksApi }`. */
export type PortsOf<T> = { readonly [K in keyof T]: ApiOf<T[K]> };

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

/** What `build` returns: one implementation for everything the manifest declares, nothing more (`manifest-match`). */
export type DaemonHalf<M extends Manifest> = Section<'routes', { readonly [K in RouteKeysOf<M>]: RouteHandler }> &
  Section<'sockets', { readonly [K in SocketKeysOf<M>]: SocketAccept }> &
  Section<'memberRoutes', { readonly [K in MemberRouteKeysOf<M>]: MemberRouteHandler }> &
  Section<'tools', { readonly [K in ToolNamesOf<M>]: ToolHandler }> &
  Section<'provides', PortsOf<TokensOf<M, 'provides'>>> &
  Section<'hooks', HookImplsOf<M>> &
  Section<'subscribers', SubscribersOf<M>>;

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

/** The per-daemon generated client a half talks through (§9.6). It checks the plugin's inventory entry first. */
export interface PluginClient {
  call<Answer = unknown>(
    route: string,
    init?: {
      readonly params?: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    },
  ): Promise<Answer>;
  subscribe<Name extends string, Payload>(event: EventDef<Name, Payload>, listener: (payload: Payload) => void): Cancel;
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

export interface CliContext<M extends Manifest> {
  readonly manifest: M;
  readonly client: PluginClient;
  readonly io: TerminalIo;
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
