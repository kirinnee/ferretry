import type { z } from 'zod';
import type { Op } from '../contract/act.ts';
import type { ConfigDef, EventDef, HookDef, PortToken, StateFileDef } from '../contract/define.ts';
import type { ItemKind, PluginApi } from '../contract/ids.ts';
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

/** One option a verb takes, as `fy <verb> --help` lists it: the flag as typed (`--compact-at <tokens|auto>`) and its sentence. */
export interface VerbOptionDecl {
  readonly flag: string;
  readonly help: string;
  /** The verb refuses to run without it (`error: required option '--scope <scope>' not specified`), before any handler. */
  readonly required?: boolean;
}

/** One positional argument a verb takes, as `fy <verb> --help` lists it under Arguments. */
export interface VerbArgDecl {
  /** The placeholder name (`id`, `name`): shown as `<id>`, `[id]` when optional, `[id...]` when variadic. */
  readonly name: string;
  readonly help: string;
  readonly optional?: boolean;
  readonly variadic?: boolean;
}

/** A `fy` verb (code) or an alias to an existing verb (data). */
export interface VerbDecl<Verb extends string = string> {
  readonly verb: Verb;
  readonly summary?: string;
  /**
   * The arguments `fy <verb> --help` lists. An empty array says the verb takes none; leaving it out means the verb
   * line's own placeholders (`<id>`, `[name...]`) are shown without a sentence, which a test refuses for a verb in the table.
   */
  readonly args?: readonly VerbArgDecl[];
  /** The options `fy <verb> --help` lists under the summary (only the ones worth naming; the verb's parser owns the rest). */
  readonly options?: readonly VerbOptionDecl[];
  /** Data plugins only: the verb line this alias runs (`card move --to done`). */
  readonly alias?: string;
  /**
   * Declares this verb the default of its group: the bare group (`fy catalog`, `fy catalog --json`) runs it, flags passed
   * through, where a group without one refuses with "needs a sub-verb". At most one per group, and only a direct child.
   */
  readonly default?: boolean;
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
  /** Words the command bar finds this tab by, beyond its label (the settings it holds). */
  readonly keywords?: readonly string[];
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

export type { ItemKind };

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
 * a host (`*.example.com` for subdomains), or `{ items: kind }` — the programs or hosts NAMED BY the items of that kind
 * (an MCP server's `command` / `url`): the installed, pinned data-plugin items, and the items of the owner's config
 * collection (`itemKind`), read by the kernel when the call is made; refused when no item names it. Only the kind's
 * owner may declare it.
 */
export type PermissionEntry = string | { readonly items: ItemKind } | ResolverEntry;

/**
 * A `permissions.network` or `permissions.spawn` entry whose answers the plugin's OWN daemon half gives at each call
 * (Connections' relay endpoint, from its configured or advertised value): the half implements `resolvers: { [name]:
 * () => readonly string[] }`, called with no request data. In `network` the host is allowed only when it equals one
 * answer exactly (`host` or `host:port`, no wildcard). In `spawn` the program is allowed only when an answer names it
 * exactly: an absolute answer allows only that path, a bare name allows that basename, and an answer with `*` in it
 * allows nothing. A throwing or missing resolver refuses. A resolver name serves ONE of the two fields (its answers are
 * programs in `spawn` and hosts in `network`); a name in both is refused. The resolver is the plugin's own code: the
 * kernel does not prove what it answers from.
 */
export interface ResolverEntry {
  readonly resolver: string;
}

/** A `permissions.spawn` entry: a program, what installed items name, or what the plugin's own resolver answers. */
export type SpawnEntry = string | { readonly items: ItemKind } | ResolverEntry;

/**
 * `permissions.processes`: the environment variables, by exact name, `kernel.processes.usersOf` may match. A name is
 * a plain variable name (`[A-Za-z_][A-Za-z0-9_]*`); anything else, `'*'` included, matches no variable.
 */
export interface ProcessesPermission {
  readonly environment: readonly string[];
}

/** What it may touch outside its own folder (§3.7). Anything undeclared is refused by the kernel ports. */
export interface Permissions {
  readonly roots?: readonly RootName[];
  readonly network?: readonly PermissionEntry[];
  readonly spawn?: readonly SpawnEntry[];
  /** Vault secret names it may use by name (never read). */
  readonly secrets?: readonly string[];
  /**
   * The names of Vault secrets this plugin MINTS itself (an OAuth sign-in's access token), each a pattern the whole
   * name must match (written without anchors). The Vault lets the plugin put, remove and list a name matching one, and
   * nothing else it was not already given by `secrets` or a credential record of its own.
   */
  readonly mintedSecrets?: readonly string[];
  /**
   * It offers the person a PICKER over the names of the secrets this machine holds (Catalogs' install mapping of a
   * `${secret:NAME}` placeholder). The Vault lists it every secret NAME (never a value) and writes it nothing; every
   * other non-core plugin lists only the names it may use or mints.
   */
  readonly secretNamePicker?: true;
  /**
   * It starts a command for a RUNTIME (MCP's check) and may put into that one child exactly the secrets the runtime's
   * profile references (`VaultApi.childEnvironmentForRuntime`; Runtimes answers which). Not a general grant: no other name,
   * no value, only for the call, and only a non-core plugin that declares it is handed the method.
   */
  readonly profileSecrets?: true;
  /** It reads this machine's `/proc` and `/sys` facts through `kernel.hostFacts` (today's Terminals). */
  readonly hostFacts?: true;
  /** It reads THIS process's own `/proc/self/io` and `/proc/self/stat` through `kernel.selfCounters` (Usage's profile), and no other file or pid. */
  readonly selfCounters?: true;
  /**
   * It asks `kernel.paths.checkDirectory` whether an owner-named absolute path is a directory (Ferrets' session
   * working directory, today's resolver). The check answers for ANY absolute path with no root and no fence, so a
   * plugin that does not declare it is refused by name.
   */
  readonly checkDirectory?: true;
  /**
   * It resolves a bare executable name to a path through `kernel.paths.which` (Runtimes: whether an MCP server's command
   * and a harness are installed). Bounded and never executing, but it tells what is installed where, so a plugin that
   * does not declare it is refused by name.
   */
  readonly which?: true;
  /**
   * The operator variables `kernel.paths.locate` may read as one command's override (Connections:
   * `['FY_CLOUDFLARED']`), by exact name, each `^FY_[A-Z0-9_]{1,60}$`; `'*'`, a pattern or any other spelling is a
   * name that matches no variable, for a core plugin too. Only with `which`. Absent: every `locate` is refused, and no
   * other variable is ever read.
   */
  readonly whichOverrides?: readonly string[];
  /**
   * It mints shared trees through `kernel.roots.share` (Skills: one skill folder handed, read-only, to the harness that
   * receives the launch part). It hands another plugin read of a folder it owns, so a plugin that does not declare it
   * is refused by name.
   */
  readonly shareTrees?: true;
  /**
   * The sign-in file basenames it may hand to a receiving plugin through `kernel.roots.shareCredential` (Logins:
   * `['auth.json']`, Codex's sign-in), by exact name, each one plain file name; `'*'`, a pattern or a path matches
   * nothing. Only the plugin that may hold `credentials` can mint, whatever it declares. Absent: every mint is refused.
   */
  readonly shareCredentials?: readonly string[];
  /**
   * It asks `kernel.processes` about this user's live processes and SIGTERMs one that runs from its own folder
   * (Runtimes: an ended Codex ferret's app-server pair). `environment` lists, by exact name, the variables `usersOf`
   * may match (`CODEX_HOME`); nothing else is matched, and `'*'` is a name that matches no variable. Absent: every
   * member is refused naming the plugin.
   */
  readonly processes?: ProcessesPermission;
  /**
   * The basenames `kernel.roots.harnessFile` may open beside a harness home (Runtimes: `['.claude.json']`, the file
   * Claude keeps its user-scope MCP servers in, BESIDE `~/.claude`). Each is matched exactly, as one plain file name;
   * `'*'`, a pattern, a path, `.` or `..` is a name that matches no file. Only with `harness-home` in `roots` and only
   * for the plugin that may hold it. Absent: every `harnessFile` is refused.
   */
  readonly harnessFiles?: readonly string[];
  /**
   * The relative paths a `project-files` handle may reach inside the ONE absolute folder it is scoped to per call (MCP:
   * `['.mcp.json']`; Skills: every skill folder under `.claude/skills` and `.agents/skills`, and everything below it). A pattern is `/`-separated: the first
   * segment a literal name, any other a literal or `*` (exactly one segment), the last may be `**` (everything below the
   * folder before it, at least one entry). Matched case-exactly. Never absolute, never `..`, never a bare `**` or a
   * leading `*` (`plugin-graph` refuses one). Only legal with `project-files` in `roots`. Absent or no match: every name
   * of the root is refused `not_declared`.
   */
  readonly projectFiles?: readonly string[];
  /**
   * It may change the permission bits of an EXISTING name in its writable roots (`RootHandle.setMode`: the harness
   * launch step that makes a copied tool executable). Opt-in: a plugin that holds a writable owner root (`work`,
   * `worktrees`) could otherwise widen an existing folder or file there. `'*'` grants none. Absent: `setMode` is refused
   * with `not_declared`.
   */
  readonly setMode?: true;
  /**
   * The programs `kernel.spawn.start` may start DETACHED (`SpawnOptions.detached`: its own process group, outliving the
   * daemon; Browsers: the platform link opener, `xdg-open` / `open`). Each must also be in `spawn`. Matched as `spawn`
   * matches a name; `'*'` or any pattern names no program, for a core piece too. Absent: every detached start is refused.
   */
  readonly detached?: readonly string[];
  /** It reads the running build's facts and launches the self-update through `kernel.updateHost` (Updates). */
  readonly updateHost?: true;
}

/**
 * The plugin a per-needer `provides` entry is built for (§3.7): its id and its EFFECTIVE permissions, the ones the
 * kernel's own ports enforce for it (`effectivePermissions`: a `'*'` in `spawn` or `network` survives for a core id
 * alone). A provider that acts on a caller's behalf narrows what it does to these, so a needer reaches nothing through
 * the provider that its own manifest does not declare. The kernel itself, binding a kernel-bound port, is `kernel`.
 */
export interface Needer {
  readonly id: string;
  readonly permissions: Permissions;
  /**
   * Every `${secret:NAME}` the needer's OWN credential records name (config defs marked `credentialRecords`), as they are IN EFFECT now (asked at each call): a
   * reference added by a plugin or a hand edit is held for the owner and names nothing until the owner confirms it,
   * so only an owner-written reference is here. The needer's records are the needer's to write; a provider may count
   * these names as the needer's own, beside `permissions.secrets`.
   */
  readonly ownedSecretReferences: () => ReadonlySet<string>;
  /**
   * The KERNEL's own answer to "may this plugin reach this host", asked at the call: its `network` entries of every
   * kind (a plain host, an installed item's, a `{ resolver }` answer), exactly what its own `kernel.fetch` allows. A
   * provider that sends a request for the needer asks THIS rather than reading `permissions.network`, which a resolver
   * entry grants nothing through. Absent (a bare needer): only the literal entries count, as `neederMayReach` reads them.
   */
  readonly mayReach?: (hostname: string, host: string) => boolean;
}

/** A state file that names itself like a secret but is not one, with the reason a reviewer can check. */
export interface PublicFileDecl {
  /** Relative to `state/<id>/`, as a `defineState` path is (one `*` at most). */
  readonly path: string;
  readonly reason: string;
}

/**
 * Which of a plugin's state files a ferret must never reach (§7.7, §9.3). The kernel composes every plugin's list into
 * the one list its fence reads (no kernel → plugin import): each `private` entry is pinned by IDENTITY, so a bind mount
 * or alias of it is refused under any name, through any root. A state file named like a secret (key, secret, token,
 * passkey, credential, oauth) must be declared one way or the other, or the manifest is refused.
 *
 * Each `private` entry is pinned by IDENTITY (device and inode) from the first look of the fence index after boot, and
 * a private file CREATED (or replaced) later THROUGH THE DAEMON's state port or internal roots is pinned before that
 * write returns: those writers ask the index to look again first, so a first write has no window. Root calls made
 * after the write returns are covered; a root call already running alongside the write is not. A private file made
 * OUTSIDE the daemon is pinned only at the index's next look, within 250 ms (as in v4): a file the CLI's own state
 * port makes (Access's `fy pair --open` redirect page under `pairing-redirects`), and a file a child process makes
 * inside a private folder. An entry met through any root under another name, a bind mount included, is refused
 * `fenced` (fail closed). A look that cannot be made fails closed too: the write rejects with `private_unpinned` and
 * every root refuses until a look can be made, and the daemon says once "A private file of <plugin> could not be
 * pinned, so no folder is opened until it can be: <reason>." (again after a private write's look has succeeded in
 * between; the index's own looks do not end the outage for this sentence).
 * There is no second field for this: `private` is the declaration.
 */
export interface PrivacyDecl {
  /** Paths relative to `state/<id>/`: a file, a folder, or a collection (`credentials/*` pins the folder). */
  readonly private?: readonly string[];
  /** Secret-named files that are not secret, each with a written reason. */
  readonly public?: readonly PublicFileDecl[];
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

  // `fyd --check` seams (DECISIONS-2 #22). None of them runs at boot.
  /** Ids of PURE descriptive `fyd --check` lines: the half implements `preflight: { [id]: (facts) => lines }`. */
  readonly preflight?: readonly string[];
  /** Ids of bounded probes ONLY `fyd --check` runs: the half implements `selftest: { [id]: { label, run } }`. */
  readonly selftest?: readonly string[];
  /** Ids of the worker thread programs this plugin embeds: the half implements `workers: { [id]: URL }`, which `fyd --check` starts. */
  readonly workers?: readonly string[];

  readonly permissions?: Permissions;

  /** The state files a ferret must never reach, and the secret-named ones that are safe (`PrivacyDecl`). */
  readonly privacy?: PrivacyDecl;
}
