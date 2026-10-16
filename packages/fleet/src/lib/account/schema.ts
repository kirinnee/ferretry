/**
 * The version-2 fleet configuration — Machine, Credential, Component, Profile, Runtime — as the one
 * place an untrusted version-2 document becomes a domain type.
 *
 * The words are the product's words (docs/design/account-model.md §2) and nothing else: there is no
 * agent, route, variant, identity, home or lane here. Everything a later unit needs to reason about
 * the model — flattening a profile, materialising a runtime, adapting a component — reads these types,
 * so they say exactly what the design's §5.3 says and no more.
 *
 * WHAT IS NOT HERE, on purpose:
 *
 * - **No runtime id.** Ids are opaque and live in Ferretry's state (`ids.json`, R6), so renaming a
 *   runtime in the config can never break a join.
 * - **No wrapper or config-directory path.** Both are derived from the runtime's name and id.
 * - **No `flags` or `env` on a runtime or profile.** Settings is where flags and environment live
 *   (K4); the only environment in the config outside a component is a credential's, and only when
 *   that credential IS an environment (`store: environment`).
 *
 * Every rule that spans two fields is checked by one parse and named in a sentence that says which
 * field it is about, in the style of `../config.ts`: a person who typed a layer that does not exist
 * is told which profile, which layer and what exists instead.
 *
 * Pure throughout: no filesystem, no environment, no clock.
 */
import { isLoopbackHost } from '@ferretry/protocol';
import { z } from 'zod';
import { AliasSchema, EnvSchema, SafeNameSchema, UsageSchema } from '../config.ts';
import { HarnessKindSchema } from '../manifest.ts';

/** A URL a bearer token may be sent to: HTTPS, or plain HTTP only to this machine. */
const secureMcpUrl = (url: string): boolean => {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
};

const NonEmptyString = z.string().min(1);

/** The version this module parses. Any other document is refused (`./document.ts`). */
export const ACCOUNT_MODEL_VERSION = 2 as const;

const NAME_GRAMMAR = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

const nameSchema = () =>
  z.string().max(64).regex(NAME_GRAMMAR, {
    message: 'use only letters, digits and dashes, starting and ending with a letter or digit',
  });

/**
 * A runtime's name (R1): letters, digits and dashes, and no dash at either end. It is the CLI wrapper
 * a person types, so it must survive being a filename and a shell word without quoting.
 *
 * A credential id uses the same grammar, because it is the directory name of a `store: ferretry`
 * credential (`<FY_HOME>/fleet/credentials/<id>/`).
 */
export const RuntimeNameSchema = nameSchema();

/** A credential's id. The same grammar as a runtime name; see {@link RuntimeNameSchema}. */
export const CredentialIdSchema = nameSchema();

/**
 * A record whose KEYS are names, each checked with a sentence that says what is wrong with it.
 *
 * A record key schema reports only "Invalid key in record", so a person who typed `claude.work` as a
 * runtime name would not be told the grammar. The keys are checked here instead, as `../config.ts`
 * checks environment variable names.
 */
const namedRecord = <T extends z.ZodType>(value: T, name: z.ZodType<string>, what: string) =>
  z.record(z.string(), value).check(ctx => {
    for (const key of Object.keys(ctx.value)) {
      const parsed = name.safeParse(key);
      if (parsed.success) continue;
      ctx.issues.push({
        code: 'custom',
        message: `${what} "${key}": ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
        input: key,
        path: [key],
      });
    }
  });

/** Whether `value` satisfies the runtime-name grammar. One owner, so a suggestion can be checked too. */
export const isRuntimeName = (value: string): boolean => RuntimeNameSchema.safeParse(value).success;

// ── Machine ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The machine's **Agent permissions** (F4): how an agent runtime's permission mode is set by the
 * fixed layer. `auto` stops to ask before anything that looks risky; `skip` never stops to ask.
 */
export const AgentPermissionsSchema = z.enum(['auto', 'skip']);
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;

/**
 * "What agents may control" (T, session-spec.html Settings): the three things a person can switch
 * off independently for every agent runtime on this machine. All default on, because the product
 * starts open and the switch is the escape hatch (same posture as `docs/grants.md`'s permissive
 * defaults) — never read as a security boundary against the operator's own agents, only as a kill
 * switch for one kind of thing they do.
 */
export const AgentControlSchema = z
  .strictObject({
    terminals: z.boolean().default(true),
    browsers: z.boolean().default(true),
    files: z.boolean().default(true),
  })
  .prefault({});
export type AgentControl = z.infer<typeof AgentControlSchema>;

/**
 * The runtime name Ferretry's first run gives the first Claude Code it imports (§4.3 step 4's
 * suggestion). Not a schema default — a machine that never imported this way has no such runtime —
 * but the one name {@link resolveDefaultRuntime} tries when the machine named no default itself.
 */
export const DEFAULT_RUNTIME_NAME = 'claude-default';

export const MachineSchema = z
  .strictObject({
    agentPermissions: AgentPermissionsSchema.default('auto'),
    /**
     * "Default runtime for new agents" (T): the runtime a session starts on when nobody names one.
     * Unset rather than defaulted to {@link DEFAULT_RUNTIME_NAME} here, so a machine with no such
     * runtime still parses — {@link resolveDefaultRuntime} is where the fallback actually happens.
     * When set, it must name an agent runtime on this machine (checked below, by `AccountModelSchema`,
     * where the runtimes it is checked against are in scope).
     */
    defaultRuntime: RuntimeNameSchema.optional(),
    agentControl: AgentControlSchema,
  })
  .prefault({});
export type Machine = z.infer<typeof MachineSchema>;

// ── Credential ───────────────────────────────────────────────────────────────────────────────────

/**
 * Where a credential is kept (C3).
 *
 * - `host` — the person's own `~/.claude` / `~/.codex` login, shared in place. Ferretry keeps a
 *   pointer and never a copy, and at most one per harness can exist (C4).
 * - `ferretry` — a login Ferretry signed in, under `<FY_HOME>/fleet/credentials/<id>/`.
 * - `environment` — no login at all: the credential's own `env` authenticates every runtime on it.
 */
export const CredentialStoreSchema = z.enum(['host', 'ferretry', 'environment']);
export type CredentialStore = z.infer<typeof CredentialStoreSchema>;

/**
 * Set by Clone (C8, L2) on everything it copies: where it came from. Display only.
 *
 * - `clonedFrom` — the source machine by the name it gave ITSELF, so never proof of anything.
 * - `clonedFromDaemon` — the source's daemon id AS THE COPYING BROWSER REPORTED IT: the fingerprint it
 *   paired with, which a surface turns into the reader's own label for that machine. The target cannot
 *   check it, so it is exactly as true as the browser that staged the copy, which already holds this
 *   machine's `fleet.configure`.
 */
const CLONE_ORIGIN_SHAPE = {
  clonedFrom: NonEmptyString.optional(),
  clonedFromDaemon: NonEmptyString.optional(),
};

/**
 * One login to one harness on this machine (C1, C2). Stored exactly once; every runtime that names it
 * reads that one store.
 */
export const CredentialSchema = z
  .strictObject({
    harness: HarnessKindSchema,
    store: CredentialStoreSchema.default('ferretry'),
    /** Display only (C9): what tells two logins with one email apart. */
    label: NonEmptyString.optional(),
    ...CLONE_ORIGIN_SHAPE,
    /** `store: environment` only. A secret travels as a `${secret:NAME}` reference, never a value. */
    env: EnvSchema.optional(),
  })
  .check(ctx => {
    const credential = ctx.value;
    if (credential.store === 'environment') {
      if (credential.env === undefined || Object.keys(credential.env).length === 0) {
        ctx.issues.push({
          code: 'custom',
          message: 'a credential kept in the environment must say which variables authenticate it, in "env"',
          input: credential.env,
          path: ['env'],
        });
      }
      return;
    }
    if (credential.env !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: `"env" belongs only to a credential with store: environment — this one is store: ${credential.store}`,
        input: credential.env,
        path: ['env'],
      });
    }
  });
export type Credential = z.infer<typeof CredentialSchema>;

// ── Components ───────────────────────────────────────────────────────────────────────────────────

/**
 * The six kinds of component, spelled exactly as the `components` block's keys and as the first half
 * of a layer reference (`instructions/main`, `modelSets/heavy`).
 */
export const COMPONENT_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets'] as const;
export const ComponentKindSchema = z.enum(COMPONENT_KINDS);
export type ComponentKind = z.infer<typeof ComponentKindSchema>;

/** A component file, relative to the asset tree unless it starts with `/`, `~` or `$HOME`. */
const ComponentFileSchema = NonEmptyString;

/** Instructions (generic, K2): one document, optionally narrowed to one harness (K3). */
export const InstructionsComponentSchema = z.strictObject({
  file: ComponentFileSchema,
  harness: HarnessKindSchema.optional(),
  ...CLONE_ORIGIN_SHAPE,
});
export type InstructionsComponent = z.infer<typeof InstructionsComponentSchema>;

/**
 * One MCP server (generic, K2): either a command Ferretry's runtimes start (`command` + `args`) or a
 * server they reach at a `url`. Exactly one of the two, because a server that is both is a server
 * nobody can say how to start.
 */
export const McpComponentSchema = z
  .strictObject({
    command: NonEmptyString.optional(),
    args: z.array(z.string()).optional(),
    env: EnvSchema.optional(),
    url: z.url().optional(),
    /**
     * `oauth`: a server reached at `url` that is signed in to from Ferretry. The daemon keeps its tokens
     * in the secret store and the runtime reads the access token by variable name (docs/mcp-oauth.md).
     */
    auth: z.literal('oauth').optional(),
    harness: HarnessKindSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const server = ctx.value;
    if ((server.command === undefined) === (server.url === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'an MCP server needs exactly one of "command" (a server to start) or "url" (a server to reach)',
        input: server,
        path: [],
      });
      return;
    }
    if (server.url !== undefined && (server.args !== undefined || server.env !== undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: '"args" and "env" start a command — a server reached at a "url" takes neither',
        input: server,
        path: [server.args === undefined ? 'env' : 'args'],
      });
    }
    if (server.auth !== undefined && server.url === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: '"auth" signs in to a server reached at a "url" — a server Ferretry starts has nothing to sign in to',
        input: server,
        path: ['auth'],
      });
    }
    // A signed-in server is sent a bearer token on every launch: never over cleartext to another host.
    if (server.auth !== undefined && server.url !== undefined && !secureMcpUrl(server.url)) {
      ctx.issues.push({
        code: 'custom',
        message: '"auth" sends a token to this server, so its "url" must be https:// (plain http only on this machine)',
        input: server,
        path: ['url'],
      });
    }
  });
export type McpComponent = z.infer<typeof McpComponentSchema>;

/** Skills (generic, K2): a selection of items from the skills store, each landing under its own name. */
export const SkillsComponentSchema = z
  .strictObject({
    items: z.array(SafeNameSchema).min(1),
    harness: HarnessKindSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const seen = new Set<string>();
    ctx.value.items.forEach((item, index) => {
      if (seen.has(item)) {
        ctx.issues.push({
          code: 'custom',
          message: `skill item "${item}" is listed twice`,
          input: item,
          path: ['items', index],
        });
      }
      seen.add(item);
    });
  });
export type SkillsComponent = z.infer<typeof SkillsComponentSchema>;

/**
 * Settings (one harness, K2) — and the one place flags and environment live (K4). Any of the three
 * may be given alone, but a settings component must say something.
 *
 * - `file` — the harness's own settings document (`settings.json`, `config.toml`). Layers deep-merge
 *   per harness, the later key winning (§3.4).
 * - `flags` — launch arguments, in order. Layers **append**, oldest first, so a later layer's flag
 *   comes later on the command line. Appending rather than replacing is what version 1 did, and it is
 *   what lets a later layer add one flag without restating every earlier one.
 * - `env` — launch environment. Layers merge **by variable**, the later layer winning. A secret is a
 *   `${secret:NAME}` reference, never a value, and the variables that bind a runtime to its config
 *   directory or its credential are refused (`RESERVED_ENV_NAMES`).
 */
export const SettingsComponentSchema = z
  .strictObject({
    harness: HarnessKindSchema,
    file: ComponentFileSchema.optional(),
    flags: z.array(NonEmptyString).min(1).optional(),
    env: EnvSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const settings = ctx.value;
    if (settings.file === undefined && settings.flags === undefined && settings.env === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a settings component needs at least one of "file", "flags" or "env"',
        input: settings,
        path: [],
      });
    }
  });
export type SettingsComponent = z.infer<typeof SettingsComponentSchema>;

/**
 * Hooks (one harness, K2): a hooks `file`, or a `directory` of the scripts hooks run. Exactly one,
 * because each lands at its own place in a runtime's config directory and one component is one thing.
 */
export const HooksComponentSchema = z
  .strictObject({
    harness: HarnessKindSchema,
    file: ComponentFileSchema.optional(),
    directory: ComponentFileSchema.optional(),
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const hooks = ctx.value;
    if ((hooks.file === undefined) === (hooks.directory === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message: 'a hooks component needs exactly one of "file" (a hooks document) or "directory" (hook scripts)',
        input: hooks,
        path: [],
      });
    }
  });
export type HooksComponent = z.infer<typeof HooksComponentSchema>;

/** A model set (K2, K8): model ids and the one a runtime uses when nobody names one. */
export const ModelSetComponentSchema = z
  .strictObject({
    models: z.array(NonEmptyString).min(1),
    default: NonEmptyString,
    ...CLONE_ORIGIN_SHAPE,
  })
  .check(ctx => {
    const set = ctx.value;
    const seen = new Set<string>();
    set.models.forEach((model, index) => {
      if (seen.has(model)) {
        ctx.issues.push({
          code: 'custom',
          message: `model "${model}" is listed twice`,
          input: model,
          path: ['models', index],
        });
      }
      seen.add(model);
    });
    if (!set.models.includes(set.default)) {
      ctx.issues.push({
        code: 'custom',
        message: `default "${set.default}" is not one of this model set's models (${set.models.join(', ')})`,
        input: set.default,
        path: ['default'],
      });
    }
  });
export type ModelSetComponent = z.infer<typeof ModelSetComponentSchema>;

/** The component name grammar: safe as a path component, and never containing the layer separator. */
export const ComponentNameSchema = SafeNameSchema;

export const ComponentsSchema = z
  .strictObject({
    instructions: namedRecord(InstructionsComponentSchema, ComponentNameSchema, 'component name').default({}),
    mcp: namedRecord(McpComponentSchema, ComponentNameSchema, 'component name').default({}),
    skills: namedRecord(SkillsComponentSchema, ComponentNameSchema, 'component name').default({}),
    settings: namedRecord(SettingsComponentSchema, ComponentNameSchema, 'component name').default({}),
    hooks: namedRecord(HooksComponentSchema, ComponentNameSchema, 'component name').default({}),
    modelSets: namedRecord(ModelSetComponentSchema, ComponentNameSchema, 'component name').default({}),
  })
  .prefault({});
export type Components = z.infer<typeof ComponentsSchema>;

/** One component of any kind, as its kind's own type. */
export type ComponentOf<K extends ComponentKind> = Components[K][string];

// ── Profile ──────────────────────────────────────────────────────────────────────────────────────

/** The first half of a layer reference that names another profile used as a base (P1). */
export const PROFILE_LAYER_PREFIX = 'profile' as const;

/** A layer reference as written: `<kind>/<name>` for a component, `profile/<name>` for a base. */
export type LayerReferenceText = `${ComponentKind}/${string}` | `${typeof PROFILE_LAYER_PREFIX}/${string}`;

/** A layer reference, read. */
export type LayerReference =
  | { readonly kind: 'profile'; readonly name: string }
  | { readonly kind: 'component'; readonly componentKind: ComponentKind; readonly name: string };

const LAYER_KINDS: readonly string[] = [...COMPONENT_KINDS, PROFILE_LAYER_PREFIX];

/**
 * Read a layer reference, or `undefined` when it is not one. Total over every string, so a caller
 * holding text it did not parse can still ask.
 */
export function parseLayerReference(text: string): LayerReference | undefined {
  const separator = text.indexOf('/');
  if (separator < 0) return undefined;
  const kind = text.slice(0, separator);
  const name = text.slice(separator + 1);
  if (!LAYER_KINDS.includes(kind) || !ComponentNameSchema.safeParse(name).success) return undefined;
  if (kind === PROFILE_LAYER_PREFIX) return { kind: 'profile', name };
  return { kind: 'component', componentKind: kind as ComponentKind, name };
}

/** Write a layer reference. The inverse of {@link parseLayerReference}. */
export function layerReferenceText(reference: LayerReference): LayerReferenceText {
  return reference.kind === 'profile'
    ? `${PROFILE_LAYER_PREFIX}/${reference.name}`
    : `${reference.componentKind}/${reference.name}`;
}

export const LayerReferenceTextSchema = z.string().check(ctx => {
  if (parseLayerReference(ctx.value) === undefined) {
    ctx.issues.push({
      code: 'custom',
      message: `"${ctx.value}" is not a layer — write <kind>/<name> with kind one of ${COMPONENT_KINDS.join(', ')}, or profile/<name>`,
      input: ctx.value,
    });
  }
}) as unknown as z.ZodType<LayerReferenceText, string>;

/**
 * A profile (P1): an ordered stack of layers, **oldest first**, in which the newer layer always
 * overrides the older (P2). How each kind merges is the layering module's (`./layering.ts`).
 *
 * An empty stack is accepted here — it is a profile that applies nothing, which P5 already reports as
 * unavailable — so a document can always be read. The build flow refuses to CREATE one.
 *
 * The product calls this a **Profile**. The code says `LayeredProfile` only because version 1's own
 * `Profile` (`../config.ts`) is exported from the same barrel until the old model is retired.
 */
export const LayeredProfileSchema = z.strictObject({
  layers: z.array(LayerReferenceTextSchema).default([]),
});
export type LayeredProfile = z.infer<typeof LayeredProfileSchema>;

// ── Runtime ──────────────────────────────────────────────────────────────────────────────────────

/** A runtime (R1): one credential and one profile, launched under its name. */
export const RuntimeSchema = z.strictObject({
  credential: CredentialIdSchema,
  profile: ComponentNameSchema,
  /** "Ferretry launches this as an agent" (R3): only these get the fixed layer and start unattended. */
  agent: z.boolean().default(false),
});
export type Runtime = z.infer<typeof RuntimeSchema>;

// ── Advanced ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A thin executable that runs one runtime with extra flags prepended. Named by RUNTIME NAME, because
 * runtime ids are not in the config (R6).
 */
export const RuntimeCommandSchema = z.strictObject({
  wrapper: RuntimeNameSchema,
  runtime: RuntimeNameSchema,
  flags: z.array(NonEmptyString).default([]),
});
export type RuntimeCommand = z.infer<typeof RuntimeCommandSchema>;

/** Everything a beginner never sees, carried over from version 1. */
export const AdvancedSchema = z
  .strictObject({
    /** Shell file every wrapper sources before it runs, so `$NAME` references resolve. */
    secretsFile: NonEmptyString.optional(),
    aliases: namedRecord(AliasSchema, SafeNameSchema, 'alias name').default({}),
    commands: z.array(RuntimeCommandSchema).default([]),
    usage: UsageSchema,
    /** Whether the CLI prints the line that puts the wrappers on `PATH`. */
    path: z.strictObject({ announce: z.boolean().default(true) }).prefault({}),
  })
  .prefault({});
export type Advanced = z.infer<typeof AdvancedSchema>;

// ── The whole document ───────────────────────────────────────────────────────────────────────────

type Issue = { code: 'custom'; message: string; input: unknown; path: (string | number)[] };

const listOf = (names: Iterable<string>): string => {
  const all = [...names];
  return all.length === 0 ? 'none' : all.join(', ');
};

/**
 * The profile names `name` reaches through its `profile/…` layers, itself excluded unless it loops
 * back. Iterative, so a pathological chain cannot exhaust the stack.
 */
function reachedProfiles(profiles: Readonly<Record<string, LayeredProfile>>, name: string): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [name];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const layer of profiles[next]?.layers ?? []) {
      const reference = parseLayerReference(layer);
      if (reference?.kind !== 'profile' || reached.has(reference.name)) continue;
      reached.add(reference.name);
      pending.push(reference.name);
    }
  }
  return reached;
}

/**
 * Whether profile `name` would include `candidate` — directly, through a base, or by being it. The
 * "Would include itself" rule (P3, E19) a build flow disables a base with.
 */
export function wouldIncludeItself(
  profiles: Readonly<Record<string, LayeredProfile>>,
  name: string,
  candidate: string,
): boolean {
  return candidate === name || reachedProfiles(profiles, candidate).has(name);
}

/**
 * A whole version-2 fleet configuration, `<FY_HOME>/fleet/config.yaml` (§5.3).
 *
 * Strict everywhere, so a typo is an error rather than a silently ignored key, and cross-referential:
 * an unknown credential, profile or layer, a profile that reaches itself, a second `host` login for
 * one harness, and a command naming a runtime that does not exist are all reported by one parse.
 */
export const AccountModelSchema = z
  .strictObject({
    version: z.literal(ACCOUNT_MODEL_VERSION),
    machine: MachineSchema,
    credentials: namedRecord(CredentialSchema, CredentialIdSchema, 'credential id').default({}),
    components: ComponentsSchema,
    profiles: namedRecord(LayeredProfileSchema, ComponentNameSchema, 'profile name').default({}),
    runtimes: namedRecord(RuntimeSchema, RuntimeNameSchema, 'runtime name').default({}),
    advanced: AdvancedSchema,
  })
  .check(ctx => {
    const model = ctx.value;
    const push = (issue: Issue): void => {
      ctx.issues.push(issue);
    };

    // C4: one `host` login per harness, because there is one `~/.claude` and one `~/.codex`.
    const hostOwners = new Map<string, string>();
    for (const [id, credential] of Object.entries(model.credentials)) {
      if (credential.store !== 'host') continue;
      const owner = hostOwners.get(credential.harness);
      if (owner === undefined) {
        hostOwners.set(credential.harness, id);
        continue;
      }
      push({
        code: 'custom',
        message: `"${id}" and "${owner}" are both your own ${credential.harness} login (store: host) — a machine has only one, so one of them must be store: ferretry`,
        input: credential.store,
        path: ['credentials', id, 'store'],
      });
    }

    for (const [name, profile] of Object.entries(model.profiles)) {
      profile.layers.forEach((layer, index) => {
        // Already a valid reference: the element schema refused anything else.
        const reference = parseLayerReference(layer) as LayerReference;
        const path = ['profiles', name, 'layers', index];
        if (reference.kind === 'profile') {
          if (model.profiles[reference.name] === undefined) {
            push({
              code: 'custom',
              message: `profile "${name}" uses unknown profile "${reference.name}" as a layer (profiles: ${listOf(Object.keys(model.profiles))})`,
              input: layer,
              path,
            });
          }
          return;
        }
        const existing = model.components[reference.componentKind];
        if (existing[reference.name] === undefined) {
          push({
            code: 'custom',
            message: `profile "${name}" uses unknown ${reference.componentKind} component "${reference.name}" (${reference.componentKind}: ${listOf(Object.keys(existing))})`,
            input: layer,
            path,
          });
        }
      });
      // P3: reported once per profile, on the profile, rather than once per layer of the loop.
      if (reachedProfiles(model.profiles, name).has(name)) {
        push({
          code: 'custom',
          message: `profile "${name}" includes itself through its layers — a profile can never be its own base`,
          input: profile.layers,
          path: ['profiles', name, 'layers'],
        });
      }
    }

    // T: "Default runtime for new agents" must name an agent runtime actually on this machine —
    // refused here, by name, the same way an unknown credential or profile is.
    if (model.machine.defaultRuntime !== undefined) {
      const named = model.runtimes[model.machine.defaultRuntime];
      if (named === undefined || !named.agent) {
        const agentRuntimes = Object.entries(model.runtimes)
          .filter(([, runtime]) => runtime.agent)
          .map(([runtimeName]) => runtimeName);
        push({
          code: 'custom',
          message: `the default runtime for new agents, "${model.machine.defaultRuntime}", is not an agent runtime on this machine (agent runtimes: ${listOf(agentRuntimes)})`,
          input: model.machine.defaultRuntime,
          path: ['machine', 'defaultRuntime'],
        });
      }
    }

    for (const [name, runtime] of Object.entries(model.runtimes)) {
      if (model.credentials[runtime.credential] === undefined) {
        push({
          code: 'custom',
          message: `runtime "${name}" uses unknown credential "${runtime.credential}" (credentials: ${listOf(Object.keys(model.credentials))})`,
          input: runtime.credential,
          path: ['runtimes', name, 'credential'],
        });
      }
      if (model.profiles[runtime.profile] === undefined) {
        push({
          code: 'custom',
          message: `runtime "${name}" uses unknown profile "${runtime.profile}" (profiles: ${listOf(Object.keys(model.profiles))})`,
          input: runtime.profile,
          path: ['runtimes', name, 'profile'],
        });
      }
    }

    // A command is an executable beside the runtimes' own, so it may not take a runtime's name or
    // another command's.
    const wrapperOwners = new Map<string, string>(Object.keys(model.runtimes).map(name => [name, `runtime ${name}`]));
    model.advanced.commands.forEach((command, index) => {
      if (model.runtimes[command.runtime] === undefined) {
        push({
          code: 'custom',
          message: `command "${command.wrapper}" runs unknown runtime "${command.runtime}"`,
          input: command.runtime,
          path: ['advanced', 'commands', index, 'runtime'],
        });
      }
      const owner = wrapperOwners.get(command.wrapper);
      if (owner !== undefined) {
        push({
          code: 'custom',
          message: `command "${command.wrapper}" has the same name as ${owner}`,
          input: command.wrapper,
          path: ['advanced', 'commands', index, 'wrapper'],
        });
        return;
      }
      wrapperOwners.set(command.wrapper, `command ${command.wrapper}`);
    });
  });
export type AccountModel = z.infer<typeof AccountModelSchema>;

/** What an author writes: the same document before defaults are filled in. */
export type AccountModelDocument = z.input<typeof AccountModelSchema>;

/**
 * Parse a version-2 document from untrusted input, so downstream code holds an {@link AccountModel}
 * rather than a promise that one was checked. Throws a `ZodError` naming every problem at once.
 */
export function parseAccountModel(input: unknown): AccountModel {
  return AccountModelSchema.parse(input);
}

/**
 * "Default runtime for new agents" (T), resolved: the machine's own setting when it has one — the
 * schema above already refused anything that is not an agent runtime here — or else
 * {@link DEFAULT_RUNTIME_NAME} when THAT is an agent runtime on this machine, or else `undefined`
 * when neither resolves, which a start without an explicit runtime must then refuse in its own words.
 */
export function resolveDefaultRuntime(model: AccountModel): string | undefined {
  if (model.machine.defaultRuntime !== undefined) return model.machine.defaultRuntime;
  return model.runtimes[DEFAULT_RUNTIME_NAME]?.agent === true ? DEFAULT_RUNTIME_NAME : undefined;
}
