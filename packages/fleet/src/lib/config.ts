/**
 * The fleet configuration schema — the one place untrusted YAML becomes a domain type.
 *
 * Everything composes from profiles: a profile is a reusable bundle of harness settings, a variant
 * is a lane that bundle is cloned into, and an agent binds them to one provider account. Each
 * (agent × variant) pair the author opts into becomes one **account route**, and a route carries
 * the metadata the fleet manifest publishes.
 *
 * Two deliberate departures from the tool this replaces:
 *
 * - **Identity is declared, not derived.** Every route supplies its own UUID, its own wrapper name
 *   and its own home. Nothing infers a harness, a lane, or an account from a filename, so account
 *   names may contain hyphens, look like an alias, or collide with any prefix a reader might
 *   imagine, and everything still joins correctly.
 * - **Availability is declared.** A route that says a model is down cannot also offer it.
 *
 * Names are still checked for filesystem safety: they become path components, and a traversal
 * segment or separator in one would let a configuration write outside the directories it owns.
 */
import { z } from 'zod';
import { malformedSecretReference } from '@ferretry/protocol';
import type { AssetField } from './assets.ts';
import { canonicalAssetReference } from './paths.ts';
import { AccountIdSchema, AccountModeSchema, type FleetManifestModel, HarnessKindSchema } from './manifest.ts';
import type { SchemaCapabilityDeclaration } from './unimplemented.ts';

const NonEmptyString = z.string().min(1);

const CONTROL_CHARACTER_LIMIT = 0x20;

/**
 * A name that is safe to use as a path component and as an executable name. Intentionally
 * permissive about *shape* — arbitrary account names are preserved verbatim — and strict only
 * about the characters that would escape a directory or corrupt a generated script.
 */
export const SafeNameSchema = NonEmptyString.max(64)
  .refine(value => value.trim() === value, { message: 'must not start or end with whitespace' })
  .refine(value => !/[/\\]/.test(value), { message: 'must not contain a path separator' })
  .refine(value => value !== '.' && value !== '..' && !value.includes('..'), {
    message: 'must not contain a path traversal segment',
  })
  .refine(value => ![...value].some(character => (character.codePointAt(0) ?? 0) < CONTROL_CHARACTER_LIMIT), {
    message: 'must not contain control characters',
  });

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A POSIX environment variable name. */
export const EnvNameSchema = z.string().regex(POSIX_ENV_NAME, {
  message: 'must be a POSIX environment variable name',
});

/**
 * Variables that bind a harness to its configuration directory. A route declares its `home`
 * explicitly, so allowing configuration to also set these would let an account silently detach
 * from the home the manifest publishes for it.
 */
export const RESERVED_ENV_NAMES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_SQLITE_HOME'] as const;

/**
 * An environment value, in one of three spellings.
 *
 * - `$NAME` or `${NAME}` — an indirect reference, resolved from the process environment when the
 *   wrapper runs.
 * - `${secret:NAME}`, anywhere inside the value — this daemon's secret store supplies it at launch,
 *   and the value is never written into a generated script. See `./env-profiles.ts`; that is what
 *   lets a profile authenticate an account instead of a login.
 * - anything else — a literal.
 *
 * A MALFORMED `${secret:…}` IS REFUSED rather than treated as a literal. `${secret:work_key}` matches
 * no reference, so it would be exported verbatim and the harness would authenticate with the text of
 * the reference — a credential failure whose cause is invisible in every place a person would look.
 */
export const EnvValueSchema = z.string().check(ctx => {
  const malformed = malformedSecretReference(ctx.value);
  if (malformed !== undefined) {
    ctx.issues.push({
      code: 'custom',
      message: `"${malformed}" is not a secret reference — a secret name is uppercase letters, digits and underscores, as in \${secret:WORK_KEY}`,
      input: ctx.value,
    });
  }
});

/**
 * Keys are checked explicitly rather than through a key schema: a record key schema reports only
 * "Invalid key in record", and an operator who wrote `CODEX_HOME` deserves to be told that the
 * variable is reserved rather than left guessing which key offended.
 */
export const EnvSchema = z.record(z.string(), EnvValueSchema).check(ctx => {
  for (const name of Object.keys(ctx.value)) {
    if (!POSIX_ENV_NAME.test(name)) {
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" must be a POSIX environment variable name`,
        input: name,
        path: [name],
      });
      continue;
    }
    if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) {
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" is reserved — an account's home is declared by its "home" field, not by the environment`,
        input: name,
        path: [name],
      });
    }
  }
});
export type EnvMap = z.infer<typeof EnvSchema>;

/**
 * The named documents this fleet offers as shared assets, per asset field.
 *
 * A shared asset has always been expressible — several accounts naming one path in the asset tree
 * get one source copied into each home — but nothing *declared* which paths those were, so no
 * consumer could tell "the shared default" from "a path this account happens to name". This registry
 * is that declaration and nothing more: it gives paths names, so a surface can offer them, count who
 * uses them, and say per account whether an asset is shared or account-local without inferring it.
 *
 * It confers no behaviour of its own. Registering a path does not link anybody to it, and an account
 * still uses a shared document by naming it in the composition chain exactly as before. That is why
 * declaring the registry is a safe migration for a host that already has one shared CLAUDE.md: every
 * account that already referenced it becomes *recognised* as sharing it, and nothing moves on disk.
 *
 * Names are per field, so `settings` may hold one entry per harness — a Claude `settings.json` and a
 * Codex `config.toml` are two documents and two names, never one shared file that both would fight
 * over. See `sharing.ts` for what the names mean and which fields may be linked.
 */
const SharedDocumentsSchema = z.record(SafeNameSchema, NonEmptyString);

/**
 * Annotated over every asset field rather than spelled loosely: a newly added asset field is a
 * compile error here instead of a field that silently can never be shared.
 */
const sharedAssetsShape: Readonly<Record<AssetField, typeof SharedDocumentsSchema>> = {
  settings: SharedDocumentsSchema,
  memory: SharedDocumentsSchema,
  skills: SharedDocumentsSchema,
  hooks: SharedDocumentsSchema,
  hooksDir: SharedDocumentsSchema,
  mcp: SharedDocumentsSchema,
};

export const SharedAssetsSchema = z.strictObject({
  settings: sharedAssetsShape.settings.default({}),
  memory: sharedAssetsShape.memory.default({}),
  skills: sharedAssetsShape.skills.default({}),
  hooks: sharedAssetsShape.hooks.default({}),
  hooksDir: sharedAssetsShape.hooksDir.default({}),
  mcp: sharedAssetsShape.mcp.default({}),
});
export type SharedAssets = z.infer<typeof SharedAssetsSchema>;

/** A settings layer: a path to a base file, or an object of overrides to merge on top of one. */
export const SettingsLayerSchema = z.union([NonEmptyString, z.record(z.string(), z.unknown())]);
export type SettingsLayer = z.infer<typeof SettingsLayerSchema>;

const SettingsFieldSchema = z.union([SettingsLayerSchema, z.array(SettingsLayerSchema).min(1)]);

/**
 * The skill items this layer selects, each one individually addressable.
 *
 * A **list**, because the shared pool is a store of items rather than a folder-shaped blob: the store
 * holds `skills/review`, `skills/deploy`, `skills/research`, and an account takes the subset it needs.
 * One directory string could only ever say "take all of it", which is why per-item selection could not
 * be expressed before. Each selected item is materialized under its own name inside the harness's
 * skills destination, so two accounts selecting one item read one source and neither can see the
 * other's picks.
 *
 * A bare reference is the selection of one — the same shorthand `settings` accepts for a single layer —
 * so the field has exactly one shape downstream and nothing has to branch on how it was written. An
 * empty list is a *declared* selection of nothing, which is how one account drops every item an
 * earlier composition slot handed it; that is why it is accepted rather than refused.
 */
const SkillsFieldSchema = z.union([NonEmptyString, z.array(NonEmptyString)]);

const profileFieldShape = {
  env: EnvSchema.optional(),
  flags: z.array(NonEmptyString).optional(),
  settings: SettingsFieldSchema.optional(),
  memory: NonEmptyString.optional(),
  skills: SkillsFieldSchema.optional(),
  hooks: NonEmptyString.optional(),
  hooksDir: NonEmptyString.optional(),
  mcp: NonEmptyString.optional(),
};

/** A profile with no per-harness overlays. Overlays are one level deep and cannot nest. */
export const BaseProfileSchema = z.strictObject(profileFieldShape);
export type BaseProfile = z.infer<typeof BaseProfileSchema>;

const overlayShape = {
  ...profileFieldShape,
  claude: BaseProfileSchema.optional(),
  codex: BaseProfileSchema.optional(),
};

/**
 * A reusable bundle. May carry `claude:` / `codex:` overlays that apply only to an agent of that
 * harness, which is how one cross-harness variant varies a per-harness asset.
 */
export const ProfileSchema = z.strictObject(overlayShape);
export type Profile = z.infer<typeof ProfileSchema>;

/** A lane every opted-in agent is cloned into. `mode` here is the default for its routes. */
export const VariantSchema = z.strictObject({
  profiles: z.array(NonEmptyString).optional(),
  mode: AccountModeSchema.optional(),
  ...overlayShape,
});
export type Variant = z.infer<typeof VariantSchema>;

/**
 * A model an account may serve, as somebody WRITES it. A bare string is shorthand for "available,
 * no display name"; the long form adds a display name, or takes the model out of service with a
 * reason.
 *
 * THE AUTHORING FORM IS NOT THE PUBLISHED FORM, and that is the point rather than a duplication. The
 * manifest publishes a discriminated union in which `available` is mandatory and an unavailable
 * entry cannot exist without its reason — exactly right for a consumer, and hostile to an author:
 * writing `{ id: claude-sonnet-5, displayName: Sonnet 5 }` in `config.yaml` was refused with
 * `✖ Invalid input → at models[1]`, because the union's `true` branch demanded a field nobody had
 * any reason to type. A person who could not discover the long form could not declare an unavailable
 * model at all, and so could never say why one was off.
 *
 * So authoring is flat and forgiving, each mistake earns a sentence naming the field it is about, and
 * the transform is the ONE bridge to the published shape. Its return type is annotated
 * {@link FleetManifestModel}, so the manifest stays the authority on what may be produced and any
 * drift between the two is a compile error rather than a manifest nobody can parse.
 *
 * The transform switches on the REASON rather than on `available` because, once the checks below have
 * passed, carrying a reason and being unavailable are the same fact — which makes it total without a
 * fallback branch that could quietly publish an unavailable model as an available one.
 */
export const ModelDeclarationSchema = z.preprocess(
  value => (typeof value === 'string' ? { id: value } : value),
  z
    .strictObject({
      id: NonEmptyString,
      /** What a person reads instead of the identifier. The identifier is still what a caller names. */
      displayName: NonEmptyString.optional(),
      /** Omitted means available: a model nobody said was down is up, exactly as for an account. */
      available: z.boolean().default(true),
      /** Required when `available` is false, and refused otherwise. */
      unavailableReason: NonEmptyString.optional(),
    })
    .check(ctx => {
      const model = ctx.value;
      if (!model.available && model.unavailableReason === undefined) {
        ctx.issues.push({
          code: 'custom',
          message: `model "${model.id}" is declared unavailable but does not say why — add unavailableReason`,
          input: model.unavailableReason,
          path: ['unavailableReason'],
        });
      }
      if (model.available && model.unavailableReason !== undefined) {
        ctx.issues.push({
          code: 'custom',
          message: `model "${model.id}" gives a reason it is unavailable but is still offered — add "available: false"`,
          input: model.available,
          path: ['available'],
        });
      }
    })
    .transform((model): FleetManifestModel => {
      const named = model.displayName === undefined ? {} : { displayName: model.displayName };
      return model.unavailableReason === undefined
        ? { id: model.id, available: true, ...named }
        : { id: model.id, available: false, unavailableReason: model.unavailableReason, ...named };
    }),
);

/**
 * One account: an (agent × variant) pair the author opted into. Everything a consumer joins on is
 * declared here, so nothing downstream has to reconstruct it from a name.
 */
export const AccountRouteSchema = z.strictObject({
  id: AccountIdSchema,
  wrapper: SafeNameSchema,
  /** Relative names resolve to `<FY_HOME>/fleet/homes/<name>`; use that portable default instead
   * of `~/.claude-*` / `~/.codex-*` so each account home stays inside Ferretry's state home. */
  home: NonEmptyString,
  mode: AccountModeSchema.optional(),
  displayName: NonEmptyString.optional(),
  defaultModel: NonEmptyString.optional(),
  models: z.array(ModelDeclarationSchema).default([]),
  available: z.boolean().default(true),
  unavailableReason: NonEmptyString.optional(),
  /**
   * This one account's own overlay, applied after every shared slot. Two routes on the same agent
   * can therefore carry different instructions, skills, settings and environment without either
   * one leaking onto the other — which an agent-wide inline field cannot express.
   */
  layer: ProfileSchema.optional(),
});
export type AccountRoute = z.infer<typeof AccountRouteSchema>;

/** How an account authenticates. Declared, because inferring it from a base URL misclassifies. */
export const AuthModeSchema = z.enum(['oauth', 'api-key']);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const AgentSchema = z.strictObject({
  name: SafeNameSchema,
  kind: HarnessKindSchema,
  auth: AuthModeSchema.default('oauth'),
  /** The agent whose provider login this one shares. Defaults to the agent's own name. */
  identity: SafeNameSchema.optional(),
  profiles: z.array(NonEmptyString).optional(),
  /** Variant name → the account it produces. An agent must produce at least one account. */
  routes: z.record(NonEmptyString, AccountRouteSchema),
  ...overlayShape,
});
export type Agent = z.infer<typeof AgentSchema>;

/** A thin executable that runs one account's wrapper with extra flags prepended. */
export const CommandSchema = z.strictObject({
  wrapper: SafeNameSchema,
  /** The account this command runs — by id, never by wrapper name. */
  target: AccountIdSchema,
  flags: z.array(NonEmptyString).default([]),
});
export type CommandDefinition = z.infer<typeof CommandSchema>;

const AliasFlagsSchema = z.union([NonEmptyString, z.array(NonEmptyString).min(1)]);

/**
 * One alias fans out into a command for every account of each harness it lists. Flags are
 * per-harness because each harness names its flags differently; an unlisted harness gets nothing.
 */
export const AliasSchema = z
  .strictObject({ claude: AliasFlagsSchema.optional(), codex: AliasFlagsSchema.optional() })
  .refine(value => value.claude !== undefined || value.codex !== undefined, {
    message: 'must list flags for at least one harness',
  });
export type Alias = z.infer<typeof AliasSchema>;

const positiveSeconds = (fallback: number) => z.number().int().positive().default(fallback);

/** The schema default and the R3 comparison share this one value. */
export const USAGE_JITTER_DEFAULT = 0.25;

export const HealthSchema = z
  .strictObject({
    /** Off by default: every probe is a real model call. */
    enabled: z.boolean().default(false),
    interval: positiveSeconds(300),
    concurrency: z.number().int().positive().default(8),
    timeout: positiveSeconds(90),
  })
  .prefault({});

/** A local proxy pool that reports runtime availability rather than a numeric usage window. */
export const CliProxySourceSchema = z
  .strictObject({
    url: z.url(),
    /** Literal value, or a `$NAME` reference resolved from the environment. */
    managementKey: NonEmptyString.optional(),
    /** File holding the management key. Preferred: keeps the secret out of the configuration. */
    managementKeyFile: NonEmptyString.optional(),
    /** Accounts this pool serves, by id. */
    accounts: z.array(AccountIdSchema).min(1),
  })
  .refine(source => (source.managementKey === undefined) !== (source.managementKeyFile === undefined), {
    message: 'set exactly one of managementKey or managementKeyFile',
  });
export type CliProxySource = z.infer<typeof CliProxySourceSchema>;

export const UsageSchema = z
  .strictObject({
    /** On by default: a usage read is cheap and consumes no quota. */
    enabled: z.boolean().default(true),
    interval: positiveSeconds(60),
    jitter: z.number().min(0).max(1).default(USAGE_JITTER_DEFAULT),
    concurrency: z.number().int().positive().default(6),
    timeout: positiveSeconds(15),
    atLimitPercent: z.number().min(1).max(100).default(100),
    relogin: z.boolean().default(true),
    sync: z.boolean().default(true),
    cliProxy: z.array(CliProxySourceSchema).default([]),
  })
  .prefault({});

const availabilityIssues = (
  route: AccountRoute,
  path: readonly (string | number)[],
  push: (issue: { code: 'custom'; message: string; input: unknown; path: (string | number)[] }) => void,
): void => {
  if (route.available && route.unavailableReason !== undefined) {
    push({
      code: 'custom',
      message: 'an available account must not carry an unavailableReason',
      input: route.unavailableReason,
      path: [...path, 'unavailableReason'],
    });
  }
  if (!route.available && route.unavailableReason === undefined) {
    push({
      code: 'custom',
      message: 'an unavailable account must state an unavailableReason',
      input: route.unavailableReason,
      path: [...path, 'unavailableReason'],
    });
  }
  if (route.available && route.defaultModel === undefined) {
    push({
      code: 'custom',
      message: 'an available account must name a defaultModel it can actually serve',
      input: route.defaultModel,
      path: [...path, 'defaultModel'],
    });
    return;
  }
  if (route.defaultModel === undefined) return;

  const chosen = route.models.find(model => model.id === route.defaultModel);
  if (!chosen) {
    push({
      code: 'custom',
      message: `defaultModel "${route.defaultModel}" is not one of this account's models`,
      input: route.defaultModel,
      path: [...path, 'defaultModel'],
    });
    return;
  }
  if (!chosen.available) {
    push({
      code: 'custom',
      message: `defaultModel "${route.defaultModel}" is declared unavailable (${chosen.unavailableReason})`,
      input: route.defaultModel,
      path: [...path, 'defaultModel'],
    });
  }
};

/**
 * The whole fleet. Strict everywhere, so a typo is an error rather than a silently ignored key,
 * and cross-referential: unknown profiles, unknown variants, duplicate identities and incoherent
 * availability are all reported by one parse instead of surfacing later during provisioning.
 */
export const FleetConfigSchema = z
  .strictObject({
    /**
     * Shell file sourced by every generated wrapper before it execs, so `$NAME` references resolve.
     * Absent means no secrets file is sourced.
     */
    secretsFile: NonEmptyString.optional(),
    /** Named shared documents, per asset field. Declarative only — see {@link SharedAssetsSchema}. */
    shared: SharedAssetsSchema.prefault({}),
    profiles: z.record(NonEmptyString, ProfileSchema).default({}),
    variants: z.record(NonEmptyString, VariantSchema).prefault({ default: {} }),
    agents: z.array(AgentSchema).default([]),
    commands: z.array(CommandSchema).default([]),
    aliases: z.record(SafeNameSchema, AliasSchema).default({}),
    /** Harness → the account whose assets the bare upstream CLI home receives, by id. */
    defaultHomes: z
      .strictObject({ claude: AccountIdSchema.optional(), codex: AccountIdSchema.optional() })
      .prefault({}),
    sharedHistory: z
      .strictObject({ claude: z.boolean().default(false), codex: z.boolean().default(false) })
      .prefault({}),
    health: HealthSchema,
    usage: UsageSchema,
  })
  .check(ctx => {
    const config = ctx.value;
    const push = (issue: { code: 'custom'; message: string; input: unknown; path: (string | number)[] }): void => {
      ctx.issues.push(issue);
    };

    // Two names for one path would make "which shared document is this account linked to" a question
    // with two answers, and the whole point of the registry is that it has one. Refused per field,
    // because the same document legitimately serves two fields — one file can be both a memory
    // document and, for another harness, nothing at all.
    for (const [field, documents] of Object.entries(config.shared)) {
      const owners = new Map<string, string>();
      for (const [name, path] of Object.entries(documents)) {
        // Compared canonically, so `./CLAUDE.md` and `CLAUDE.md` are caught as the one document they
        // are rather than admitted as two names the sharing report would then disagree about.
        const owner = owners.get(canonicalAssetReference(path));
        if (owner !== undefined) {
          push({
            code: 'custom',
            message: `shared ${field} "${name}" names the same document as "${owner}"; one path may carry only one shared name`,
            input: path,
            path: ['shared', field, name],
          });
          continue;
        }
        owners.set(canonicalAssetReference(path), name);
      }
    }

    const variantNames = new Set(Object.keys(config.variants));
    const profileNames = new Set(Object.keys(config.profiles));
    const agentNames = new Set(config.agents.map(agent => agent.name));

    const checkProfileRefs = (names: readonly string[], path: (string | number)[]): void => {
      names.forEach((name, index) => {
        if (!profileNames.has(name)) {
          push({ code: 'custom', message: `unknown profile "${name}"`, input: name, path: [...path, index] });
        }
      });
    };

    for (const [variantName, variant] of Object.entries(config.variants)) {
      checkProfileRefs(variant.profiles ?? [], ['variants', variantName, 'profiles']);
    }

    const routeIds = new Map<string, string>();
    const wrapperOwners = new Map<string, string>();
    const homeOwners = new Map<string, string>();
    const accountsById = new Map<string, { kind: string }>();

    config.agents.forEach((agent, agentIndex) => {
      checkProfileRefs(agent.profiles ?? [], ['agents', agentIndex, 'profiles']);

      if (agent.identity !== undefined && !agentNames.has(agent.identity)) {
        push({
          code: 'custom',
          message: `unknown identity "${agent.identity}" — it must name a declared agent`,
          input: agent.identity,
          path: ['agents', agentIndex, 'identity'],
        });
      }

      const routeEntries = Object.entries(agent.routes);
      if (routeEntries.length === 0) {
        push({
          code: 'custom',
          message: 'an agent must declare at least one route',
          input: agent.routes,
          path: ['agents', agentIndex, 'routes'],
        });
      }

      for (const [variantName, route] of routeEntries) {
        const path = ['agents', agentIndex, 'routes', variantName];
        if (!variantNames.has(variantName)) {
          push({ code: 'custom', message: `unknown variant "${variantName}"`, input: variantName, path });
        }

        const idOwner = routeIds.get(route.id);
        if (idOwner) {
          push({
            code: 'custom',
            message: `duplicate account id "${route.id}" — already used by ${idOwner}`,
            input: route.id,
            path: [...path, 'id'],
          });
        } else {
          routeIds.set(route.id, `${agent.name}/${variantName}`);
          accountsById.set(route.id, { kind: agent.kind });
        }

        const wrapperOwner = wrapperOwners.get(route.wrapper);
        if (wrapperOwner) {
          push({
            code: 'custom',
            message: `duplicate wrapper "${route.wrapper}" — already used by ${wrapperOwner}`,
            input: route.wrapper,
            path: [...path, 'wrapper'],
          });
        } else {
          wrapperOwners.set(route.wrapper, `${agent.name}/${variantName}`);
        }

        const homeOwner = homeOwners.get(route.home);
        if (homeOwner) {
          push({
            code: 'custom',
            message: `duplicate home "${route.home}" — already used by ${homeOwner}; accounts must not share credentials`,
            input: route.home,
            path: [...path, 'home'],
          });
        } else {
          homeOwners.set(route.home, `${agent.name}/${variantName}`);
        }

        availabilityIssues(route, path, push);
      }
    });

    config.commands.forEach((command, index) => {
      if (!accountsById.has(command.target)) {
        push({
          code: 'custom',
          message: `unknown target "${command.target}" — it must be a declared account id`,
          input: command.target,
          path: ['commands', index, 'target'],
        });
      }
      const owner = wrapperOwners.get(command.wrapper);
      if (owner) {
        push({
          code: 'custom',
          message: `wrapper "${command.wrapper}" is already used by ${owner}`,
          input: command.wrapper,
          path: ['commands', index, 'wrapper'],
        });
      } else {
        wrapperOwners.set(command.wrapper, `command ${command.wrapper}`);
      }
    });

    for (const [kind, id] of Object.entries(config.defaultHomes)) {
      if (id === undefined) continue;
      const account = accountsById.get(id);
      if (!account) {
        push({
          code: 'custom',
          message: `unknown account id "${id}"`,
          input: id,
          path: ['defaultHomes', kind],
        });
      } else if (account.kind !== kind) {
        push({
          code: 'custom',
          message: `account "${id}" is a ${account.kind} account, not ${kind}`,
          input: id,
          path: ['defaultHomes', kind],
        });
      }
    }

    for (const [index, source] of config.usage.cliProxy.entries()) {
      source.accounts.forEach((id, accountIndex) => {
        if (!accountsById.has(id)) {
          push({
            code: 'custom',
            message: `unknown account id "${id}"`,
            input: id,
            path: ['usage', 'cliProxy', index, 'accounts', accountIndex],
          });
        }
      });
    }
  });
export type FleetConfig = z.infer<typeof FleetConfigSchema>;

/**
 * The fleet settings this schema accepts for migration compatibility but this build cannot honour.
 *
 * This is deliberately adjacent to {@link FleetConfigSchema}: accepting a setting is not the same
 * as implementing it, and a caller can print this declaration mechanically with
 * {@link unimplementedCapabilities}. Removing an entry is the commit that implements it.
 */
export const FleetConfigCapabilities = {
  unimplementedCapabilities: [
    {
      key: 'usage.cliProxy',
      capability: 'reading runtime availability from a local CLIProxyAPI pool',
      consequence: 'the accounts that pool serves report as ordinary accounts, so a pool in cooldown looks usable',
      requested: (config: FleetConfig) => config.usage.cliProxy.length > 0,
    },
    {
      key: 'health.enabled',
      capability: 'probing each account with a real model call to prove it can complete a turn',
      // PERMANENTLY unimplemented, by decision rather than by backlog. That probe billed a model turn
      // per account on a timer for nobody, and it is deleted rather than gated — see
      // `docs/fleet-health.md`. What replaced it needs no flag because it costs nothing: account
      // health rides the free read-only usage GET the quota pass already makes, so it is on whenever
      // that pass is. This entry stays because the SETTING is still accepted, and accepting a setting
      // is not the same as implementing it.
      consequence:
        'nothing proves an account can complete a turn; account health reports whether its credential was accepted, which is a narrower and free claim',
      requested: (config: FleetConfig) => config.health.enabled,
    },
    {
      key: 'usage.jitter',
      capability: 'spreading a fleet’s background probes so they do not synchronize',
      consequence:
        'the daemon re-collects when a snapshot has aged past usage.interval rather than on a timer, so there is no synchronized cycle to spread',
      requested: (config: FleetConfig) => config.usage.jitter !== USAGE_JITTER_DEFAULT,
    },
  ],
} as const satisfies SchemaCapabilityDeclaration<FleetConfig>;
