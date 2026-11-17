/**
 * @ferretry/plugin-runtimes/contract — wire schemas, ids, port + token, events, config declarations, words (§2.1).
 * Packs imports `RuntimeId` from here (the one plugin→plugin contract edge §2.4 allows to Runtimes).
 */
import { type Brand, InstantSchema } from '@ferretry/std';
import {
  defineConfig,
  defineEvent,
  definePort,
  type Loosens,
  neverLoosens,
  type Word,
} from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretsPort, HarnessKeySchema } from '@ferretry/core-ferrets/contract';
import { configDef } from './config-def.ts';
import {
  ITEM_NAME_PATTERN,
  type InstructionsFile,
  InstructionsFileSchema,
  ModelSetFileSchema,
  ProfileFileSchema,
  RuntimeFileSchema,
  RuntimeNameSchema,
  RuntimesFileSchema,
  runtimeFileLoosens,
} from './config.ts';
import { RUNTIME_HOME_READ_MODELS, type RuntimeHomesApi } from './homes.ts';
import { RUNTIME_LAYER_READ_MODELS, type RuntimeLayersApi } from './layers.ts';
import type { MachineTool, RuntimeView } from './wire/index.ts';
import type { BrowserFirewallFailureSchema, BrowserPortsSettingSchema } from './wire/shared.ts';

export * from './codex-launch.ts';
export * from './component-source.ts';
export * from './homes.ts';
export * from './layers.ts';
export * from './profile-stack.ts';
export * from './slots.ts';
export * from './tools-server.ts';
export * from './config.ts';
export * from './wire/index.ts';

/** The plugin id. */
export const RUNTIMES = 'runtimes' as const;

// ─── ids ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A runtime's id: its name, as the file `config/runtimes/<name>.yaml` carries it. Runtimes keep no state of their own
 * (§9.2), so there is no minted id; what Packs, Board and Ferrets store is this name.
 */
export type RuntimeId = Brand<string, 'RuntimeId'>;
export const RuntimeIdSchema = RuntimeNameSchema.transform(value => value as RuntimeId);

// ─── words (§1) ──────────────────────────────────────────────────────────────────────────────────────────────────

export const RUNTIMES_WORDS: readonly Word[] = [
  {
    word: 'runtime',
    means: 'a named way to start a ferret: harness + login + model + shell + tools',
    insteadOf: ['preset'],
  },
  { word: 'profile', means: 'a reusable set of instructions, MCP servers and skills' },
];

// ─── the port ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A runtime as others read it: enough to start a ferret on it or to list it. */
export const RuntimeSummarySchema = z.strictObject({
  id: RuntimeIdSchema,
  harness: HarnessKeySchema,
  /** The login it spends. */
  login: z.string().min(1),
  profile: z.string().min(1),
  /** The shell item it enters (Q18), when it names one. */
  shell: z.string().min(1).optional(),
  /** Launched as an unattended agent (R3). */
  agent: z.boolean(),
  /** Whether it can launch now; when not, `reason` is the button's words. */
  launch: z.discriminatedUnion('available', [
    z.strictObject({ available: z.literal(true) }),
    z.strictObject({ available: z.literal(false), reason: z.string().min(1) }),
  ]),
  disabled: z.strictObject({ reason: z.string().optional(), until: InstantSchema.optional() }).optional(),
});
export type RuntimeSummary = z.infer<typeof RuntimeSummarySchema>;

/** Why a runtime could not be resolved to something a ferret can start on. */
export const RESOLVE_REFUSALS = ['unknown', 'disabled', 'no_login', 'no_profile', 'not_signed_in'] as const;
export type ResolveRefusal = (typeof RESOLVE_REFUSALS)[number];

export type ResolveResult =
  | { readonly ok: true; readonly runtime: RuntimeSummary }
  | { readonly ok: false; readonly refusal: ResolveRefusal; readonly sentence: string };

export interface RuntimesApi extends RuntimeHomesApi, RuntimeLayersApi {
  /** Every runtime on this machine, in name order. */
  list(): Promise<readonly RuntimeSummary[]>;
  get(id: RuntimeId): Promise<RuntimeSummary | undefined>;
  /** The machine's default runtime, resolved: the setting, else `claude-default` when it is an agent runtime here. */
  default(): Promise<RuntimeId | undefined>;
  /** What a start on this runtime (or the default, when `id` is omitted) would use, or why it cannot start. */
  resolve(id?: RuntimeId): Promise<ResolveResult>;
  /**
   * Every runtime with its models, wrapper and login, as `GET /v1/runtimes` answers: what `fy recommend` offers a start
   * from (Packs reads what can start now).
   */
  catalog(): Promise<readonly RuntimeView[]>;
  /** The harness CLIs on this machine and whether each is installed, as `GET /v1/runtimes/machine` answers. */
  tools(): Promise<readonly MachineTool[]>;
  /**
   * The machine's loopback-port settings, read-only: the `browserPorts` setting and what Browsers does when its own
   * account's firewall check failed (`browserFirewallFailure`). Browsers reads them for the loopback firewall doctor and
   * Logins reads `shared` from them. Only these two settings, never the rest of the machine view.
   *
   * Both are keys of `runtimes.yaml`, `random` and `warn` when left out (or the file is absent). REJECTS while that file cannot
   * be read as it stands (unreadable, a link, too large, broken): Runtimes cannot say, and a reader must treat that as
   * unknown and fail closed, never as `random`.
   */
  machineBrowserPorts(): Promise<MachineBrowserPorts>;
  /**
   * The machine's "Auto-resume after restart" switch (`runtimes.yaml` `autoResume`, on when left out): `true` on, `false`
   * off, `undefined` when it cannot be read as it stands. It is the one setting there is for "may the machine bring a ferret
   * back by itself" (no per-ferret one exists); the Warden's automatic revive reads it and treats anything but `true` as no.
   * An operator's own resume never asks it.
   */
  autoResume(): Promise<boolean | undefined>;
}
/** What {@link RuntimesApi.machineBrowserPorts} answers (Runtimes' own copy of the two schemas, `wire/shared.ts`). */
export interface MachineBrowserPorts {
  readonly browserPorts: z.infer<typeof BrowserPortsSettingSchema>;
  readonly browserFirewallFailure: z.infer<typeof BrowserFirewallFailureSchema>;
}
/** The members of {@link RuntimesApi} that read the published catalogue rather than the configuration files. */
export type RuntimeFactsApi = Pick<RuntimesApi, 'catalog' | 'tools' | 'machineBrowserPorts' | 'autoResume'>;
export const RuntimesPort = definePort<RuntimesApi>('runtimes');
export { FerretsPort };

/** Read models others and the app may call through `RuntimesPort` (`manifest.data.readModels`). */
export const RUNTIMES_READ_MODELS = [
  'list',
  'get',
  'default',
  'resolve',
  'catalog',
  'tools',
  'machineBrowserPorts',
  'autoResume',
  ...RUNTIME_HOME_READ_MODELS,
  ...RUNTIME_LAYER_READ_MODELS,
] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Runtimes, profiles or model sets changed (after the write landed). Names only. */
export const RuntimesChanged = defineEvent(
  'runtimes.changed',
  z.strictObject({
    runtimes: z.array(z.string()).readonly(),
    profiles: z.array(z.string()).readonly(),
    modelSets: z.array(z.string()).readonly(),
  }),
);

/** The default runtime moved (or was unset). */
export const RuntimesDefaultChanged = defineEvent(
  'runtimes.default-changed',
  z.strictObject({ defaultRuntime: z.string().nullable() }),
);

/**
 * A Codex ferret never started, and the pane it died in said why (it could not reach the network). `message` is the
 * sentence the owner reads; it is fixed text of Ferretry's, never pane text.
 */
export const RuntimesLaunchFailed = defineEvent(
  'runtimes.launch-failed',
  z.strictObject({ ferret: z.string().min(1), runtime: z.string().min(1), message: z.string().min(1) }),
);

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

/** `config/runtimes.yaml`: the default runtime. Pointing it elsewhere changes where an unnamed start spends: not a loosening. */
export const RUNTIMES_CONFIG = configDef(
  defineConfig({ file: 'runtimes.yaml', schema: RuntimesFileSchema, axis: 'configure', loosens: neverLoosens }),
);

/** `config/runtimes/<name>.yaml`. */
export const RUNTIME_ITEMS = configDef(
  defineConfig({
    collection: 'runtimes',
    name: ITEM_NAME_PATTERN,
    schema: RuntimeFileSchema,
    axis: 'configure',
    loosens: runtimeFileLoosens,
  }),
);

/** `config/profiles/<name>.yaml`: what an agent RUNS WITH, which every editor may already change. */
export const PROFILE_ITEMS = configDef(
  defineConfig({
    collection: 'profiles',
    name: ITEM_NAME_PATTERN,
    schema: ProfileFileSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

/**
 * What an AGENT's write of `config/instructions/<name>.yaml` is held for: EVERY add and EVERY change (owner ruling
 * !A525 item 9). Instructions are what a ferret is told to do, so a new or edited one is authority the owner must see;
 * an unchanged text holds nothing. Compared as written (a re-ordered key counts as a change: it fails closed). The
 * sentence names the file's kind, never its text. The owner's write through fy, the app or PUT /v1/config/file is never
 * held; a hand edit or a file copied onto disk is held like any unacknowledged edit until `fy config confirm`.
 */
export const instructionsItemHeld: Loosens<InstructionsFile> = (before, after) =>
  before === undefined
    ? ['agents now run with a new instructions component']
    : JSON.stringify(before) === JSON.stringify(after)
      ? []
      : ['agents now run with changed instructions'];

/**
 * `config/instructions/<name>.yaml`: the instructions components. No other plugin owns this kind, so Runtimes does; the
 * profile component source reads it live as its own. An edit changes what an agent runs with: an agent's add or change
 * is HELD for the owner (`instructionsItemHeld`).
 */
export const INSTRUCTION_ITEMS = configDef(
  defineConfig({
    collection: 'instructions',
    name: ITEM_NAME_PATTERN,
    schema: InstructionsFileSchema,
    axis: 'configure',
    loosens: instructionsItemHeld,
  }),
);

/** `config/model-sets/<name>.yaml`. */
export const MODEL_SET_ITEMS = configDef(
  defineConfig({
    collection: 'model-sets',
    name: ITEM_NAME_PATTERN,
    schema: ModelSetFileSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

// ─── audit kinds this plugin records (Gate's log; today's `fleet.configured` event, told apart by `action`) ─────────

export const RUNTIMES_AUDIT = {
  propose: 'fleet.configured:propose',
  apply: 'fleet.configured:apply',
  installTool: 'fleet.configured:install-tool',
  forgetCloneSource: 'fleet.configured:forget-clone-source',
} as const;
