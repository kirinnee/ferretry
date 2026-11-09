import type { Result } from '@ferretry/std';
import type { Actor, CellGrid, HoldDecision, Op, RevealGrant, TargetRef } from './act.ts';
import { defineBoundPort } from './define.ts';
import type { ApiRequest, ApiResponse, RouteParameters } from './http.ts';
import type { FerretId } from './ids.ts';
import type { Cancel } from './ports.ts';
import type { CallStanding, MemberRouteDescriptor, MemberStanding, ScopedRoute } from './route.ts';

/**
 * The kernel-bound ports (§7.4): provided only by the named core piece, bound by the kernel after build and before it
 * listens. Each has exactly one provider; a missing or failing one fails closed for what it guards. The interfaces
 * live here because the kernel calls them and imports no core contract; each core contract re-exports its own.
 */

// ─── Admission (Gate) ─────────────────────────────────────────────────────────────────────────────────────────────

/** Which table a call came through. Member routes are their own table (§7.1). */
export type AdmissionTable = 'route' | 'socket' | 'tool' | 'member';

export type AdmissionInput =
  | {
      readonly table: 'route' | 'socket' | 'tool';
      readonly descriptor: ScopedRoute;
      readonly request: ApiRequest;
      readonly params: RouteParameters;
    }
  | {
      readonly table: 'member';
      readonly descriptor: MemberRouteDescriptor;
      readonly request: ApiRequest;
      readonly params: RouteParameters;
    };

export type AdmissionDecision<Standing extends object = CallStanding> =
  /** `actor` is who an act runs as (§4.7), stamped by Gate from the credential; the kernel carries it to `kernel.act`. */
  | { readonly outcome: 'admitted'; readonly standing: Standing; readonly actor: Actor }
  | { readonly outcome: 'refused'; readonly response: ApiResponse };

/**
 * Called by the dispatcher, the socket upgrade and the agent-tool runner BEFORE a handler, synchronously, with the
 * descriptor and the arrival (§7.1). If it throws or answers nothing, every call except `minimum: 'none'` routes
 * without a remedy is refused.
 */
export interface Admission<Standing extends object = CallStanding, Member extends object = MemberStanding> {
  admit(input: AdmissionInput & { readonly table: 'route' | 'socket' | 'tool' }): AdmissionDecision<Standing>;
  admitMember(input: AdmissionInput & { readonly table: 'member' }): AdmissionDecision<Member>;
  /** Re-admits an open stream after a provider's `generation()` moved; false closes it (`4401`). */
  readmit(request: ApiRequest, descriptor: ScopedRoute): boolean;
  /**
   * Told-when-it-changes: the listener is called whenever the policy this admission decides from moved (a grant or
   * security edit), so the host re-asks every open stream at once instead of at its next frame (today's
   * `recheckAll`). The returned cancel drops the subscription. A throwing listener never reaches the caller.
   */
  watch?(listener: () => void): Cancel;
  /**
   * Projects `GET /v1/plugins` for this caller (§9.6): every package for the owner on the host and a ferret; for a
   * device, core, Access and each plugin with a route, socket or agent tool its grants admit (events carry no demand
   * of their own, so they do not count); core and Warden for the remote
   * warden. Anything not returned is omitted, so a limited device cannot discover it. `surfaces` is every declared
   * route, socket and agent tool of each plugin, by plugin id, as the kernel read them from the manifests: the
   * projection asks the device's grants about them, so without them a device would see only core and Access.
   */
  inventory(
    request: ApiRequest,
    entries: readonly InventoryEntry[],
    surfaces: InventorySurfaces,
  ): readonly InventoryEntry[];
  /**
   * The Gate axis of a plugin's own config write (`kernel.config.write`/`remove`): asked only when the edit
   * LOOSENS, with the plain sentences of what widens and the actor of the call in progress (the default actor outside
   * a call). `apply` puts it into
   * effect; `hold` (and an absent judge, or one that throws) holds it for the owner, the tighter version in effect.
   */
  judgeConfigWrite?(input: ConfigWriteJudgement): 'apply' | 'hold';
  /**
   * The Gate axis of the KERNEL's own config routes (`GET/PUT /v1/config/file`, `POST /v1/config/confirm`), asked
   * once per file the call touches, before it does: the file's capability on the axis the act needs (`read` is
   * `use`; `write` and `confirm` are `configure`), a person only for the acts that change, and — to
   * put a held edit into effect — the passkey proved for that act. An absent judge, or one that throws, refuses the
   * call (nobody can say who may change what).
   */
  judgeConfigAccess?(input: ConfigAccessJudgement): ConfigAccessVerdict;
  /**
   * Told after every handler of a descriptor that has `audit: { record }`, once per call, with the final status —
   * the handler's own refusals (an `ApiError`) and failures included, as today's audited-route decorator recorded
   * every outcome of the handler. A call admission refused, or a plugin not serving, never reached a handler and is
   * not told (today: "a request the authorization boundary refuses before the handler runs is not recorded"). One
   * exception, today's too: `POST /v1/agent/config` admits its own caller inside its handler, so the kernel tells Gate
   * of that refusal, with no standing.
   * Never changes the answer; a throw is swallowed.
   */
  recorded?(call: RecordedCall): void;
}

/** What the caller does to one config file (`Admission.judgeConfigAccess`). */
export type ConfigAct = 'read' | 'write' | 'confirm';

/** What Gate is asked before the kernel's config routes touch one file. */
export interface ConfigAccessJudgement {
  readonly plugin: string;
  /** The file, relative to `config/`. */
  readonly path: string;
  readonly act: ConfigAct;
  /** Who the call in progress runs as. */
  readonly actor: Actor;
  /** The standing admission put on the call in progress; absent when none is (a job) and on a member call. */
  readonly standing?: CallStanding;
}

/**
 * Gate's answer: the call may go on, or it is refused with Gate's own answer (a grant refusal, a step-up demand, an
 * owner-only refusal). On a write, `mayLoosen` says this call may put a loosening into effect in this same act
 * (somebody at this machine), and `claimLoosening` is how a call that holds a passkey proof earns that: asked ONLY when
 * the text really loosens, it takes the one proof atomically (`true`: put it into effect). One proof, one loosening.
 */
export type ConfigAccessVerdict =
  | { readonly allowed: true; readonly mayLoosen?: boolean; readonly claimLoosening?: () => boolean }
  | { readonly allowed: false; readonly response: ApiResponse };

/** What Gate's judge is asked about one loosening config edit. */
export interface ConfigWriteJudgement {
  readonly plugin: string;
  /** The file, relative to `config/`. */
  readonly path: string;
  readonly removal: boolean;
  readonly sentences: readonly string[];
  /**
   * Set by the kernel ONLY for a `ConfigPort.writeAsCaller`, never by a plugin: `sentences` are then the
   * `${secret:NAME}` references the edit adds, and the question is whether the call in progress IS the owner (the host
   * admin where it arrived on the host, or an unlocked device whose grants hold the file's configure capability). It
   * is never a loosening to confirm with a step-up proof, so a judge claims no proof for it.
   */
  readonly secretAdd?: true;
  /** Who the call in progress runs as. */
  readonly actor: Actor;
  /**
   * The standing admission put on the call in progress, for a judge that must tell the owner at the machine from a
   * remote device (`actor` cannot). Absent when no call is in progress (a job) and on a member call.
   */
  readonly standing?: CallStanding;
}

/** One audited call, as the dispatcher reports it after the handler (or the refusal) settled. */
export interface RecordedCall {
  readonly table: 'route' | 'socket' | 'tool' | 'member';
  readonly descriptor: ScopedRoute | MemberRouteDescriptor;
  readonly request: ApiRequest;
  readonly params: RouteParameters;
  /** Gate's standing for the call; absent when admission refused it. */
  readonly standing?: object;
  readonly actor?: Actor;
  /** The session principal the call carried, if any. */
  readonly principal?: ApiRequest['principal'];
  /** The final status the caller was answered (or, for a socket, the upgrade's: 101 when accepted). */
  readonly status: number;
  /** The answer as built (a route's), for a rule that reads NAMES out of it; absent for a socket. */
  readonly response?: ApiResponse;
}

/** Every declared route, socket and agent tool of one plugin, as descriptors (no method, no path), by plugin id. */
export type InventorySurfaces = ReadonlyMap<string, readonly Omit<ScopedRoute, 'method' | 'path'>[]>;

/** One `GET /v1/plugins` entry (§9.6): `contract` is the effective contract hash. */
export interface InventoryEntry {
  readonly id: string;
  readonly on: boolean;
  readonly contract: string;
}

export const AdmissionPort = defineBoundPort<Admission>('admission', 'gate');

// ─── Output guard (Vault) ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Non-secret state the final check reads (§7.3): the hold registry and a permit generation per target, refreshed on
 * the same serialization chain as every hold change. `late` and `permit` decide from it with no await and no vault.
 */
export interface OutputGuard {
  /** Taken when a guarded body is built. */
  stamp(targets?: readonly TargetRef[]): GuardStamp;
  /** False if a hold began or a generation moved since the stamp. Synchronous; throws are read as false. */
  stillShowable(stamp: GuardStamp): boolean;
}

export interface GuardStamp {
  readonly generation: number;
  readonly targets: readonly TargetRef[];
}

export const OutputGuardPort = defineBoundPort<OutputGuard>('output-guard', 'vault');

/** The fixed withheld sentence `late` chooses when a hold began after the body was built. */
export const WITHHELD_SENTENCE = 'This was withheld because a private value was typed while it was being prepared.';

// ─── Input holds (Vault) ──────────────────────────────────────────────────────────────────────────────────────────

/** Asked by `kernel.act` inside the target's queue immediately before every act (§4.7). Synchronous. */
export interface InputHolds {
  /**
   * The fresh read a decision needs (the target adapter's `document()` / facts), awaited by the kernel INSIDE the
   * target's queue; the kernel then calls {@link decide} synchronously in the same continuation, with no await
   * between, so the decision is made on what the target is now rather than on a read from before a queued act. A
   * throw fails closed (`holds_unavailable`).
   */
  prepare?(target: TargetRef, op: Op, actor: Actor): Promise<void>;
  decide(target: TargetRef, op: Op, actor: Actor, reveal?: RevealGrant): HoldDecision;
  /**
   * Told by the kernel after each act that was allowed and whose `fn` settled successfully (a write-only act only
   * when its Ack is `done`); never for a refused or failed act, never by a tool. Feeds what follows from acts (today's
   * sign-in lock from page acts). A throw is swallowed: the act already happened.
   */
  observed?(target: TargetRef, op: Op, actor: Actor): void;
}

export const InputHoldsPort = defineBoundPort<InputHolds>('input-holds', 'vault');

// ─── Redaction (Vault) ────────────────────────────────────────────────────────────────────────────────────────────

/** The composed redactor for one read (§7.3). */
export interface RedactionScope {
  text(s: string): string;
  /** Same-width `*` over exactly the matched cells. */
  cells(grid: CellGrid): CellGrid;
  /** A value wrapped across rows is masked in each row. */
  lines(lines: readonly string[]): readonly string[];
}

/**
 * Read-scoped redaction: opens the vault's values for this read only and drops them when it returns (S20); nothing
 * is cached. A failing redactor fails closed: the read refuses, a stream closes.
 */
export interface Redaction {
  read<T>(fn: (scope: RedactionScope) => T | Promise<T>): Promise<T>;
}

export const RedactionPort = defineBoundPort<Redaction>('redaction', 'vault');

// ─── Work folders (Ferrets) ───────────────────────────────────────────────────────────────────────────────────────

declare const fencedBrand: unique symbol;
/** An absolute, symlink-resolved path a fence check accepted. Only a root handle or `WorkFolders` mints one. */
export type FencedPath = string & { readonly [fencedBrand]: true };

export type FolderRefusal = 'outside' | 'fenced' | 'unknown_ferret' | 'link_escape' | 'device_file';

/** Which folder a ferret may work in: the one it was started in, checked against the fence (§7.7). */
export interface WorkFolders {
  folderOf(ferret: FerretId): FencedPath | undefined;
  check(ferret: FerretId, path: string): Result<FencedPath, FolderRefusal>;
}

export const WorkFoldersPort = defineBoundPort<WorkFolders>('work-folders', 'ferrets');

// ─── Agent control (Ferrets) ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The five things "What agents may control" switches independently (today's `AgentControlKind`, copied):
 * `terminal`, `browser`, `files`, `settings` (the `config.*` tools: this machine's configuration files, off by
 * default) and `scripts` (`browser.eval`, off by default). A closed list: a kind not named here cannot be asked.
 */
export const AGENT_CONTROL_KINDS = ['terminal', 'browser', 'files', 'settings', 'scripts'] as const;
export type AgentControlKind = (typeof AGENT_CONTROL_KINDS)[number];

/**
 * Whether a ferret may use one kind of control on this machine, right now: the ONE reader of the owner's switches
 * (`limits.yaml`, "What agents may control"), so no plugin reads that configuration itself. Never a security boundary
 * against the operator's own agents, only a kill switch. Read fresh on every call; a ferret Ferrets does not know
 * controls nothing. Provided by Ferrets only; unbound, or when Ferrets failed, every agent act of a kind is refused.
 */
export interface AgentControlReader {
  allows(ferret: FerretId, kind: AgentControlKind): Promise<boolean>;
}

export const AgentControlPort = defineBoundPort<AgentControlReader>('agent-control', 'ferrets');

/** The name the owner sees for each switch (today's `CONTROL_SETTING`). */
const AGENT_CONTROL_SETTING: Readonly<Record<AgentControlKind, string>> = {
  terminal: 'Terminals',
  browser: 'Browsers',
  files: 'Files',
  settings: 'Ferretry settings',
  scripts: 'Page scripts',
};

/** The plain sentence an agent is told when a switch is off (today's `controlRefusal`, word for word). */
export function agentControlRefusal(kind: AgentControlKind): string {
  const setting = AGENT_CONTROL_SETTING[kind];
  // Lower-cased as a phrase, except a name that is a name: Ferretry settings.
  const phrase = setting.startsWith('Ferretry') ? setting : setting.toLowerCase();
  return `This machine does not let agents control ${phrase}: "What agents may control › ${setting}" is off in this machine's settings. Ask the person to turn it on if you need it.`;
}

// ─── Child environments (Vault) ───────────────────────────────────────────────────────────────────────────────────

declare const childEnvironmentBrand: unique symbol;

/**
 * An environment whose `${secret:NAME}` references the Vault resolved for ONE child process (lead decision 9).
 * Opaque: no field, no enumeration, no JSON (it serialises as names only). A half hands it to `kernel.spawn`, and the
 * kernel's adapter opens it at exec time, so the values are in that child's environment and in no plugin's data
 * (secrets.md "use, never read"). Vault's contract re-exports this type.
 */
export interface ChildEnvironment {
  readonly [childEnvironmentBrand]: true;
  /** The variable names it sets, for the launch record. Never a value. */
  readonly names: readonly string[];
}

/**
 * Opens a {@link ChildEnvironment} into its values, for the kernel's spawn adapter only: bound by the kernel, never
 * handed to a half. `undefined` = not a handle this Vault minted (or already spent).
 */
export interface ChildEnvironmentOpener {
  open(env: ChildEnvironment): Readonly<Record<string, string>> | undefined;
  /**
   * The handle's `PATH` value and NOTHING else, WITHOUT spending it (`kernel.paths.whichFor`, Q7): `undefined` when the
   * handle is not one this Vault minted, is already spent, sets no `PATH`, was minted for a plugin not in `readers`
   * (or for no named plugin), or its `PATH` was built from a `${secret:…}` reference. It reads exactly the `PATH` key.
   */
  searchPathOf(env: ChildEnvironment, readers: readonly string[]): string | undefined;
}

export const ChildEnvironmentPort = defineBoundPort<ChildEnvironmentOpener>('child-environment', 'vault');

/**
 * The Vault's value for one secret name, for the KERNEL's own-secret resolve only (`kernel.secrets`, lead decision J):
 * the kernel asks it after checking the plugin declared the name and its own configuration names it. `undefined` =
 * the Vault has no such secret. No half may hold it.
 */
export interface SecretResolver {
  resolve(name: string): Promise<string | undefined>;
}

export const SecretResolverPort = defineBoundPort<SecretResolver>('secret-resolver', 'vault');

/**
 * Kernel-bound ports no half may hold, not even through `needs` or `uses`: the kernel binds them into its own
 * adapters only (the ChildEnvironment opener into the spawn adapter, lead decision 8). A manifest that asks for one
 * is refused at plan, and plugin-graph refuses it in CI.
 */
export const KERNEL_ONLY_PORTS: readonly string[] = Object.freeze([ChildEnvironmentPort.name, SecretResolverPort.name]);

export const KERNEL_BOUND_PORTS = [
  AdmissionPort,
  OutputGuardPort,
  InputHoldsPort,
  RedactionPort,
  WorkFoldersPort,
  AgentControlPort,
  ChildEnvironmentPort,
  SecretResolverPort,
] as const;
