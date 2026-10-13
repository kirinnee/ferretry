/**
 * Schema pieces the version-2 fleet configuration (`./account/schema.ts`) is built from: safe names,
 * launch environment, aliases and the usage block — the one place untrusted YAML for each becomes a
 * domain type.
 *
 * Names are checked for filesystem safety: they become path components, and a traversal segment or
 * separator in one would let a configuration write outside the directories it owns.
 */
import { z } from 'zod';
import { malformedSecretReference } from '@ferretry/protocol';
import { AccountIdSchema } from './manifest.ts';
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
 * Variables configuration may never set, because Ferretry sets them and a second writer would lie.
 *
 * The first three bind a harness to its configuration directory, which Ferretry derives from the
 * runtime, so a value set here would silently detach a runtime from the directory it was given.
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` binds a Claude runtime to its CREDENTIAL
 * (docs/design/account-model.md §8.1.1), so a value set here could point a runtime at another
 * login's store.
 */
export const RESERVED_ENV_NAMES = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
] as const;
type ReservedEnvName = (typeof RESERVED_ENV_NAMES)[number];

/** Why each reserved variable is reserved, in the sentence a refusal prints. */
const RESERVED_ENV_REASONS: Readonly<Record<ReservedEnvName, string>> = {
  CLAUDE_CONFIG_DIR: "Ferretry sets it to the runtime's own config directory",
  CODEX_HOME: "Ferretry sets it to the runtime's own config directory",
  CODEX_SQLITE_HOME: "Ferretry sets it to the runtime's own config directory",
  CLAUDE_SECURESTORAGE_CONFIG_DIR:
    "Ferretry sets it to the runtime's own credential, and another value could point it at a different login",
};

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
        message: `"${name}" is reserved — ${RESERVED_ENV_REASONS[name as ReservedEnvName]}`,
        input: name,
        path: [name],
      });
    }
  }
});
export type EnvMap = z.infer<typeof EnvSchema>;

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
