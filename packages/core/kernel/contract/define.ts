import type { z } from 'zod';
import type { CoreId, ItemKind } from './ids.ts';
import type { CapabilityAxis } from './policy.ts';

// ─── Ports ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A port token: a typed interface a subsystem offers, named in its contract (§7.4). A manifest lists tokens in
 * `needs`, `uses` and `provides`; `build` receives the implementations typed by them.
 */
export interface PortToken<Api> {
  readonly kind: 'port';
  readonly name: string;
  /** Kernel-bound ports are provided only by the named core piece and bound by the kernel after build. */
  readonly boundBy?: CoreId;
  /** Phantom: carries the API type. Never read at run time. */
  readonly __api?: (api: Api) => Api;
}

export type ApiOf<T> = T extends PortToken<infer Api> ? Api : never;

export function definePort<Api>(name: string): PortToken<Api> {
  return Object.freeze({ kind: 'port', name });
}

/** A kernel-bound port (§7.4): `Admission` (gate), `InputHolds`, `OutputGuard`, `Redaction` (vault), `WorkFolders` (ferrets). */
export function defineBoundPort<Api>(name: string, boundBy: CoreId): PortToken<Api> {
  return Object.freeze({ kind: 'port', name, boundBy });
}

// ─── Events ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A wake-up a subsystem publishes after its write landed (§7.4 rule 3): in-process, at most once, possibly lost in a
 * crash. No correctness depends on one; the truth is the owner's state, read through its port.
 */
export interface EventDef<Name extends string = string, Payload = unknown> {
  readonly kind: 'event';
  readonly name: Name;
  readonly schema: z.ZodType<Payload>;
}

export type PayloadOf<E> = E extends EventDef<string, infer P> ? P : never;

export function defineEvent<const Name extends string, Payload>(
  name: Name,
  schema: z.ZodType<Payload>,
): EventDef<Name, Payload> {
  return Object.freeze({ kind: 'event', name, schema });
}

// ─── Hooks ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The five hook modes (§3.5). */
export type HookMode = 'observe' | 'decide' | 'transform' | 'provide' | 'contribute';

/**
 * A decide taker's answer. The first `no` wins, with its reason; a throw or timeout is a `no`. A `no` may carry a
 * `code` the OFFERER defined for its refusals (ADDITIVE): the kernel passes a string through untouched and never
 * interprets it; the offerer parses it against its own closed list, so a taker can never mint a code the offerer did not
 * declare. A failed, timed-out or throwing taker never carries one.
 */
export type HookDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string; readonly code?: string };

export const ALLOW: HookDecision = Object.freeze({ allow: true });

/**
 * How one live taker of a decide hook answered, in the order it was asked (ADDITIVE). `allowed` is its own
 * `allow === true`; `refused` is its own `{ allow: false }`; `unanswered` is everything the kernel turned into a no for it
 * (it failed, stopped running, timed out, threw, or answered something that is not a decision). A skeleton taker, or one
 * the walk never reached because an earlier taker said no, is not listed.
 */
export interface DecideTakerAnswer {
  readonly plugin: string;
  readonly outcome: 'allowed' | 'refused' | 'unanswered';
}

/** A decide hook's decision (exactly what `decide` answers), and who answered what on the way to it. */
export interface DecideAnswer {
  readonly decision: HookDecision;
  readonly answers: readonly DecideTakerAnswer[];
}

interface HookBase<Name extends string, Mode extends HookMode> {
  readonly kind: 'hook';
  readonly name: Name;
  readonly mode: Mode;
}

/** Takers hear that something happened, unordered, after the offerer's write. A failing taker is logged. */
export interface ObserveHook<Name extends string = string, Payload = unknown> extends HookBase<Name, 'observe'> {
  readonly payload?: z.ZodType<Payload>;
}

/**
 * Takers say yes or no to something about to happen; priority high first, then start order, then id. Synchronous or
 * bounded by `timeoutMs` (default 200). `securityPath`: only core offers or takes it (§3.5).
 */
export interface DecideHook<Name extends string = string, Input = unknown> extends HookBase<Name, 'decide'> {
  readonly input?: z.ZodType<Input>;
  readonly timeoutMs: number;
  readonly securityPath: boolean;
}

/** Takers change a value on its way; each sees the previous output; a failing taker refuses the whole operation. */
export interface TransformHook<Name extends string = string, Value = unknown> extends HookBase<Name, 'transform'> {
  readonly value?: z.ZodType<Value>;
  readonly timeoutMs: number;
}

/**
 * One taker per key is THE implementation for it; two takers of one key refuse the build. A security-path provide
 * hook names its allowed takers (`takers`); the build refuses any other (§3.5).
 */
export interface ProvideHook<Name extends string = string, Key extends string = string, Value = unknown>
  extends HookBase<Name, 'provide'> {
  readonly key: z.ZodType<Key>;
  readonly value?: z.ZodType<Value>;
  readonly takers?: readonly string[];
}

/** Takers add items to a list, ordered by the item's `order`, then id; duplicate ids refuse the build. */
export interface ContributeHook<Name extends string = string, Item = unknown> extends HookBase<Name, 'contribute'> {
  readonly item?: z.ZodType<Item>;
}

export type HookDef =
  | ObserveHook<string, any>
  | DecideHook<string, any>
  | TransformHook<string, any>
  | ProvideHook<string, string, any>
  | ContributeHook<string, any>;

/** A contributed item: an id unique within the hook, and an order. */
export interface Contribution<Item> {
  readonly id: string;
  readonly order?: number;
  readonly item: Item;
}

/** What a daemon half supplies for one taken hook, by mode. */
export type HookHandlerOf<H> =
  H extends ObserveHook<string, infer P>
    ? (payload: P) => void | Promise<void>
    : H extends DecideHook<string, infer I>
      ? (input: I) => HookDecision | Promise<HookDecision>
      : H extends TransformHook<string, infer V>
        ? (value: V) => V | Promise<V>
        : H extends ProvideHook<string, string, infer V>
          ? V
          : H extends ContributeHook<string, infer I>
            ? () => readonly Contribution<I>[]
            : never;

/** Uses `z.custom<T>()` for a value with functions (an interface), a real schema for data. */
export function defineHook<const Name extends string, Payload = unknown>(
  name: Name,
  spec: { readonly mode: 'observe'; readonly payload?: z.ZodType<Payload> },
): ObserveHook<Name, Payload>;
export function defineHook<const Name extends string, Input = unknown>(
  name: Name,
  spec: {
    readonly mode: 'decide';
    readonly input?: z.ZodType<Input>;
    readonly timeoutMs?: number;
    readonly securityPath?: boolean;
  },
): DecideHook<Name, Input>;
export function defineHook<const Name extends string, Value = unknown>(
  name: Name,
  spec: { readonly mode: 'transform'; readonly value?: z.ZodType<Value>; readonly timeoutMs?: number },
): TransformHook<Name, Value>;
export function defineHook<const Name extends string, Key extends string, Value = unknown>(
  name: Name,
  spec: {
    readonly mode: 'provide';
    readonly key: z.ZodType<Key>;
    readonly value?: z.ZodType<Value>;
    readonly takers?: readonly string[];
  },
): ProvideHook<Name, Key, Value>;
export function defineHook<const Name extends string, Item = unknown>(
  name: Name,
  spec: { readonly mode: 'contribute'; readonly item?: z.ZodType<Item> },
): ContributeHook<Name, Item>;
export function defineHook(name: string, spec: { readonly mode: HookMode } & Record<string, unknown>): HookDef {
  const base = { kind: 'hook' as const, name, ...spec };
  if (spec.mode === 'decide')
    return Object.freeze({
      ...base,
      timeoutMs: spec.timeoutMs ?? 200,
      securityPath: spec.securityPath ?? false,
    }) as HookDef;
  if (spec.mode === 'transform') return Object.freeze({ ...base, timeoutMs: spec.timeoutMs ?? 200 }) as HookDef;
  return Object.freeze(base) as HookDef;
}

// ─── State ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a declared file is stored. A `sqlite-cache` is dropped and rebuilt on mismatch (a cache rule). */
export type StateStore = 'json' | 'jsonl' | 'sqlite' | 'sqlite-cache' | 'secret' | 'opaque';

/**
 * What a file does when it is damaged (§9.3): the whole subsystem fails closed (`subsystem`), or a narrower, reviewed
 * reading that still refuses whatever the file grants (`sign-in-rules.json` reads as zero rules).
 */
export type DamagedPolicy = 'subsystem' | { readonly narrower: string };

/**
 * One declared file under `state/<id>/` (§9.2, §9.3). Every JSON document has `"format": <n>` first, starting at 1;
 * a reader accepts exactly one format (the `one-format` check). `path` may hold one `*` segment for a collection
 * (`cards/*.json`).
 */
export interface StateFileDef<Name extends string = string, Shape = unknown> {
  readonly kind: 'state';
  readonly name: Name;
  readonly path: string;
  readonly store: StateStore;
  readonly format: number;
  readonly schema?: z.ZodType<Shape>;
  readonly onDamaged: DamagedPolicy;
  /** Missing is damaged rather than empty. */
  readonly required?: true;
  /** File mode; secrets are `0o600`. */
  readonly mode?: number;
}

export function defineState<const Name extends string, Shape = unknown>(spec: {
  readonly name: Name;
  readonly path: string;
  readonly store: StateStore;
  readonly format: number;
  readonly schema?: z.ZodType<Shape>;
  readonly onDamaged?: DamagedPolicy;
  readonly required?: true;
  readonly mode?: number;
}): StateFileDef<Name, Shape> {
  if (!Number.isInteger(spec.format) || spec.format < 1) throw new TypeError(`state ${spec.name}: format starts at 1`);
  return Object.freeze({ kind: 'state', ...spec, onDamaged: spec.onDamaged ?? 'subsystem' });
}

// ─── Config ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which edits loosen spend or authority (§7.2). An empty list = not loosening; a loosening edit is held for the owner.
 * Each entry is a plain sentence naming what widened.
 *
 * A DELETION is judged too (lead decision 9, K5): `after` is the schema's defaults, or `undefined` when it has none.
 * A judgement written against this type does not expect `undefined`, so the kernel holds a deletion whose judgement
 * throws ({@link judgeLoosening}) rather than letting it through unjudged; one that answers a deletion in words is a
 * {@link LoosensWithRemoval}.
 */
export type Loosens<Shape> = (before: Shape | undefined, after: Shape) => readonly string[];

/** A {@link Loosens} that judges a deletion itself: `after` is `undefined` when the file is gone with no defaults. */
export type LoosensWithRemoval<Shape> = (before: Shape | undefined, after: Shape | undefined) => readonly string[];

/**
 * The kernel's call of a def's `loosens`: a judgement that throws (a `loosens` written before `after` could be
 * `undefined`) is a loosening that waits for the owner, never an unjudged edit.
 */
export function judgeLoosening<Shape>(
  def: { loosens(before: Shape | undefined, after: Shape | undefined): readonly string[] },
  before: Shape | undefined,
  after: Shape | undefined,
): readonly string[] {
  try {
    return def.loosens(before, after);
  } catch {
    return [
      after === undefined
        ? 'Removing this file could not be judged, so it waits for the owner.'
        : 'This edit could not be judged, so it waits for the owner.',
    ];
  }
}

interface ConfigBase<Shape> {
  readonly kind: 'config';
  readonly schema: z.ZodType<Shape>;
  /** The grant axis a remote editor needs; Gate applies it to `fy config write` and the app's editor. */
  readonly axis: CapabilityAxis;
  /** Method syntax on purpose: bivariant, so a typed `defineConfig` result is a `ConfigDef` (lead decision 4). */
  loosens(before: Shape | undefined, after: Shape | undefined): readonly string[];
  /** Person-only and passkey-checked (`plugins.yaml`, `gate.yaml`). */
  readonly personOnly?: true;
  /**
   * The files of this def are CREDENTIAL RECORDS: each one names the secrets a credential it describes is made from
   * (Logins' login records). Only the `${secret:NAME}` references in effect in a def marked so count as the owning plugin's
   * own secrets for a provider that acts for it (the Vault's spend rule); a reference in any other file counts for nothing.
   * It also means the file's TEXT is never shown by `config_read` when the file fails its check, whatever the reason
   * (it does not parse, an unknown key, a key outside `env`, a schema that throws): the located issues stay. This
   * covers every def marked so, Logins' `logins/<id>.yaml` and MCP's `mcp/<name>.yaml` alike, and costs a file whose
   * only fault is a typo key its text too.
   */
  readonly credentialRecords?: true;
}

/** One path under `config/` (YAML). */
export interface ConfigFileDef<Shape = unknown> extends ConfigBase<Shape> {
  readonly shape: 'file';
  readonly file: string;
}

/** A folder of `<name>.yaml` files with one schema. */
export interface ConfigCollectionDef<Shape = unknown> extends ConfigBase<Shape> {
  readonly shape: 'collection';
  readonly collection: string;
  readonly name: RegExp;
  /**
   * The item kind whose items THIS collection holds (an item plugin's `itemKind: 'mcp'` on `config/mcp/`): the one
   * declaration that makes `{ items: 'mcp' }` count these files' `command` and `url` as reach, live. A collection
   * that does not say so is never a reach source, whatever it is called.
   */
  readonly itemKind?: ItemKind;
}

export type ConfigDef<Shape = unknown> = ConfigFileDef<Shape> | ConfigCollectionDef<Shape>;

export function defineConfig<Shape>(spec: {
  readonly file: string;
  readonly schema: z.ZodType<Shape>;
  readonly axis: CapabilityAxis;
  /**
   * Method syntax, `after: Shape` for an inline judgement; a named {@link Loosens} (whose `after` may be
   * `undefined`) fits too. On a deletion with no defaults the kernel passes `undefined`, and a judgement that
   * throws on it is held for the owner (`judgeLoosening`), so an older inline one fails closed.
   */
  loosens(before: Shape | undefined, after: Shape): readonly string[];
  readonly personOnly?: true;
  readonly credentialRecords?: true;
}): ConfigFileDef<Shape>;
export function defineConfig<Shape>(spec: {
  readonly collection: string;
  readonly name: RegExp;
  readonly itemKind?: ItemKind;
  readonly schema: z.ZodType<Shape>;
  readonly axis: CapabilityAxis;
  loosens(before: Shape | undefined, after: Shape): readonly string[];
  readonly personOnly?: true;
  readonly credentialRecords?: true;
}): ConfigCollectionDef<Shape>;
export function defineConfig(spec: Record<string, unknown>): ConfigDef {
  return Object.freeze(
    'file' in spec ? { kind: 'config', shape: 'file', ...spec } : { kind: 'config', shape: 'collection', ...spec },
  ) as ConfigDef;
}

/** A `loosens` for a file nothing in which can widen authority or spend. */
export const neverLoosens = (): readonly string[] => [];
