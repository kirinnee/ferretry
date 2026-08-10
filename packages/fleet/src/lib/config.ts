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
import { AccountIdSchema, AccountModeSchema, FleetManifestModelSchema, HarnessKindSchema } from './manifest.ts';
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
 * An environment value. A value that is exactly `$NAME` or `${NAME}` is an indirect reference,
 * resolved from the process environment when the wrapper runs; anything else is a literal. Keeping
 * references as references is what allows provider credentials to live in the secrets file instead
 * of in a generated script.
 */
export const EnvValueSchema = z.string();

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

/** A settings layer: a path to a base file, or an object of overrides to merge on top of one. */
export const SettingsLayerSchema = z.union([NonEmptyString, z.record(z.string(), z.unknown())]);
export type SettingsLayer = z.infer<typeof SettingsLayerSchema>;

const SettingsFieldSchema = z.union([SettingsLayerSchema, z.array(SettingsLayerSchema).min(1)]);

const profileFieldShape = {
  env: EnvSchema.optional(),
  flags: z.array(NonEmptyString).optional(),
  settings: SettingsFieldSchema.optional(),
  memory: NonEmptyString.optional(),
  skills: NonEmptyString.optional(),
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

/** A model an account may serve. A bare string is shorthand for "available, no display name". */
export const ModelDeclarationSchema = z
  .union([NonEmptyString, FleetManifestModelSchema])
  .transform(value => (typeof value === 'string' ? { id: value, available: true as const } : value));

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
      consequence: 'nothing verifies an account beyond that its wrapper exists, so a broken account reads as fine',
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
