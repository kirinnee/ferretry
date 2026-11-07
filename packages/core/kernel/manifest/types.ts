import type { z } from 'zod';
import type { Op } from '../contract/act.ts';
import type { ConfigDef, EventDef, HookDef, PortToken, StateFileDef } from '../contract/define.ts';
import type { PluginApi } from '../contract/ids.ts';
import type { RootName } from '../contract/ports.ts';
import type { MemberRouteDescriptor, RouteDescriptor, ScopedRoute } from '../contract/route.ts';
import type { SocketDescriptor } from '../contract/socket.ts';
import type { InstructionWhen, Word } from '../contract/snapshot.ts';

/** What a plugin can add (§4). Each kind brings its contract and conformance suite. */
export type PluginKind =
  | 'command'
  | 'instruction'
  | 'harness'
  | 'login'
  | 'runtime'
  | 'runner'
  | 'tool'
  | 'carrier'
  | 'item'
  | 'view'
  | 'layout'
  | 'theme'
  | 'onboarding'
  | 'session-mode'
  | 'credential-provider';

/** The kinds a data plugin may carry (§3.1). */
export const DATA_KINDS = [
  'instruction',
  'runtime',
  'login',
  'item',
  'layout',
  'theme',
  'command',
  'onboarding',
] as const;

// actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A route as declared: `'GET /v1/board'` plus the full descriptor (§7.1). */
export interface RouteDecl<Key extends string = string> extends RouteDescriptor {
  readonly key: Key;
}

export interface SocketDecl<Key extends string = string> extends SocketDescriptor {
  readonly key: Key;
}

export interface MemberRouteDecl<Key extends string = string> extends MemberRouteDescriptor {
  readonly key: Key;
}

/** The descriptor of an agent tool: a route's, minus method and path. */
export type ToolDescriptor = Omit<ScopedRoute, 'method' | 'path' | 'precedence' | 'available'>;

/** An MCP tool for ferrets (§3.3). A tool-kind plugin names the `Op` of each act; the generator refuses one without. */
export interface ToolDecl<Name extends string = string> extends ToolDescriptor {
  readonly name: Name;
  readonly op?: Op;
  readonly summary?: string;
  readonly input?: z.ZodType;
}

/** A `fy` verb (code) or an alias to an existing verb (data). */
export interface VerbDecl<Verb extends string = string> {
  readonly verb: Verb;
  readonly summary?: string;
  /** Data plugins only: the verb line this alias runs (`card move --to done`). */
  readonly alias?: string;
}

/** A button or menu item on a thing, naming the route it calls; hidden when Gate would refuse this device. */
export interface AppActionDecl<Id extends string = string> {
  readonly id: Id;
  readonly on: 'card' | 'ferret' | 'ask' | 'page' | 'terminal' | 'project' | 'daemon';
  readonly label: string;
  /** A route key of this plugin or of a contract it consumes. */
  readonly calls: string;
}

// ui ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The shell's frame slots (§5.2). Plugin screens may offer their own (`<plugin>.<name>`). */
export type FrameSlot =
  | 'nav'
  | 'top'
  | 'main'
  | 'side'
  | 'bottom'
  | 'composer.tools'
  | 'ferret.side'
  | 'ferret.toolbar'
  | 'card.detail'
  | 'daemon.status'
  | 'settings'
  | 'device.settings';
export type SlotName = FrameSlot | `${string}.${string}`;

export interface ScreenDecl<Id extends string = string> {
  readonly id: Id;
  /**
   * Where the screen is served. RELATIVE (`board/:card`) is per daemon, at `/d/<daemon>/board/<card>`; ABSOLUTE
   * (`/join`) is daemon-less and must also say `daemonless: true` (the `screen-paths` check refuses it otherwise).
   */
  readonly path: string;
  /** On purpose, the screen belongs to no daemon (a share link's landing page, first-run setup). Absolute paths only. */
  readonly daemonless?: true;
  readonly nav?: { readonly label: string; readonly icon?: string; readonly order: number };
}

export interface PanelDecl<Id extends string = string> {
  readonly id: Id;
  readonly slot: SlotName;
  readonly order: number;
}

export interface SettingsTabDecl<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  readonly order: number;
}

/** Renderers are provide hooks of the app (§5.2): one per ask source, one per reference prefix. */
export type RendererDecl<Key extends string = string> =
  | { readonly kind: 'ask'; readonly source: string; readonly key: Key }
  | { readonly kind: 'reference'; readonly prefix: string; readonly key: Key };

/** A layout or theme the plugin brings, as a data file in its package. */
export interface LayoutDecl {
  readonly id: string;
  readonly file: string;
}

// data ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ItemKind =
  | 'mcp'
  | 'skill'
  | 'shell'
  | 'recipe'
  | 'instruction'
  | 'layout'
  | 'theme'
  | 'runtime'
  | 'endpoint';

export interface ItemDecl {
  readonly kind: ItemKind;
  readonly id: string;
  readonly file: string;
}

export interface DataSection {
  readonly state?: readonly StateFileDef[];
  readonly config?: readonly ConfigDef[];
  /** Queries others and the app may read through the plugin's port. */
  readonly readModels?: readonly string[];
  readonly publishes?: readonly EventDef[];
  readonly subscribes?: readonly EventDef[];
  readonly items?: readonly ItemDecl[];
}

// hooks ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Taking a hook is a start-order edge (the offerer is built first). `key` is required for a provide hook. */
export interface HookTake<H extends HookDef = HookDef> {
  readonly hook: H;
  readonly key?: string;
  /** A provide hook whose value is a schema (Asks sources): the schema this taker registers. */
  readonly schema?: z.ZodType;
  readonly priority?: number;
  /** Contribute hooks: the item order. */
  readonly order?: number;
}

export interface HookOffer<H extends HookDef = HookDef> {
  readonly hook: H;
  readonly timeoutMs?: number;
}

// metadata / permissions ───────────────────────────────────────────────────────────────────────────────────────────

export interface InstructionDecl {
  readonly id: string;
  /** A path inside the package: `instructions/board.md`. */
  readonly text: string;
  readonly when?: InstructionWhen;
}

export interface OnboardingDecl {
  readonly id: string;
  readonly title: string;
  readonly order: number;
}

/**
 * One `permissions.spawn` / `permissions.network` entry: a program (its name, or the basename of an absolute path) or
 * a host (`*.example.com` for subdomains), or `{ items: kind }` — the programs or hosts NAMED BY the owner-installed,
 * pinned items of that kind (an MCP server's `command` / `url`), resolved by the kernel when the call is made from
 * the installed items it holds; refused when no installed item names it.
 */
export type PermissionEntry = string | { readonly items: ItemKind } | ResolverEntry;

/**
 * A `permissions.network` entry whose hosts the plugin's OWN daemon half answers at each call (Connections' relay
 * endpoint, from its configured or advertised value): the half implements `resolvers: { [name]: () => readonly
 * string[] }`, called with no request data; the host is allowed only when it equals one answer exactly (`host` or
 * `host:port`, no wildcard). A throwing resolver refuses.
 */
export interface ResolverEntry {
  readonly resolver: string;
}

/** A `permissions.spawn` entry: a program, or what installed items name. A resolver reaches hosts, never programs. */
export type SpawnEntry = string | { readonly items: ItemKind };

/** What it may touch outside its own folder (§3.7). Anything undeclared is refused by the kernel ports. */
export interface Permissions {
  readonly roots?: readonly RootName[];
  readonly network?: readonly PermissionEntry[];
  readonly spawn?: readonly SpawnEntry[];
  /** Vault secret names it may use by name (never read). */
  readonly secrets?: readonly string[];
  /** It reads this machine's `/proc` and `/sys` facts through `kernel.hostFacts` (today's Terminals). */
  readonly hostFacts?: true;
  /** It reads the running build's facts and launches the self-update through `kernel.updateHost` (Updates). */
  readonly updateHost?: true;
}

// the manifest ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The one declaration (§3.3). Plain data; every field of the "Every field" table. */
export interface Manifest {
  // identity
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly api: PluginApi;
  readonly core: boolean;
  readonly kinds: readonly PluginKind[];
  readonly words?: readonly Word[];

  // dependencies (by token)
  readonly needs?: Readonly<Record<string, PortToken<any>>>;
  readonly uses?: Readonly<Record<string, PortToken<any>>>;
  readonly provides?: Readonly<Record<string, PortToken<any>>>;

  // actions
  readonly actions?: {
    readonly routes?: readonly RouteDecl[];
    readonly sockets?: readonly SocketDecl[];
    readonly memberRoutes?: readonly MemberRouteDecl[];
    readonly cli?: readonly VerbDecl[];
    readonly agentTools?: readonly ToolDecl[];
    readonly app?: readonly AppActionDecl[];
  };

  // ui
  readonly ui?: {
    readonly screens?: readonly ScreenDecl[];
    readonly panels?: readonly PanelDecl[];
    readonly settings?: readonly SettingsTabDecl[];
    readonly renderers?: readonly RendererDecl[];
    readonly layouts?: readonly LayoutDecl[];
    readonly themes?: readonly LayoutDecl[];
  };

  readonly data?: DataSection;

  readonly hooks?: {
    readonly takes?: readonly HookTake[];
    readonly offers?: readonly HookOffer[];
  };

  // order
  readonly order?: { readonly after?: readonly string[]; readonly before?: readonly string[] };
  /** 0–100, default 50: the default for its hook entries. It orders; it never overrides a refusal. */
  readonly priority?: number;

  // metadata (post-build snapshot; no start-order edge)
  readonly instructions?: readonly InstructionDecl[];
  readonly onboarding?: readonly OnboardingDecl[];
  readonly doctor?: readonly string[];

  readonly permissions?: Permissions;
}
