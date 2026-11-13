/**
 * @ferretry/plugin-runtimes/contract — wire schemas, ids, port + token, events, config declarations, words (§2.1).
 * Packs imports `RuntimeId` from here (the one plugin→plugin contract edge §2.4 allows to Runtimes).
 */
import { type Brand, InstantSchema } from '@ferretry/std';
import { defineConfig, defineEvent, definePort, neverLoosens, type Word } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretsPort, HarnessKeySchema } from '@ferretry/core-ferrets/contract';
import { configDef } from './config-def.ts';
import {
  ITEM_NAME_PATTERN,
  InstructionsFileSchema,
  ModelSetFileSchema,
  ProfileFileSchema,
  RuntimeFileSchema,
  RuntimeNameSchema,
  RuntimesFileSchema,
  runtimeFileLoosens,
} from './config.ts';
import { RUNTIME_HOME_READ_MODELS, type RuntimeHomesApi } from './homes.ts';
import type { MachineTool, RuntimeView } from './wire/catalog.ts';
import { RUNTIME_LAYER_READ_MODELS, type RuntimeLayersApi } from './layers.ts';

export * from './codex-launch.ts';
export * from './component-source.ts';
export * from './homes.ts';
export * from './layers.ts';
export * from './profile-stack.ts';
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
   * Every runtime with its models, wrapper and login, as `GET /v1/fleet/runtimes` answers: what `fy recommend` offers a
   * start from. Additive and optional: absent, a consumer has no runtime to offer.
   */
  catalog?(): Promise<readonly RuntimeView[]>;
  /** The harness CLIs on this machine and whether each is installed (`GET /v1/fleet/machine`). Additive and optional. */
  tools?(): Promise<readonly MachineTool[]>;
}
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
 * `config/instructions/<name>.yaml`: the instructions components. No other plugin owns this kind, so Runtimes does; the
 * profile component source reads it live as its own. An edit changes what an agent runs with, nothing it may spend.
 */
export const INSTRUCTION_ITEMS = configDef(
  defineConfig({
    collection: 'instructions',
    name: ITEM_NAME_PATTERN,
    schema: InstructionsFileSchema,
    axis: 'configure',
    loosens: neverLoosens,
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
