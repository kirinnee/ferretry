/**
 * The fleet manifest — the single published record of which accounts exist, where each one lives,
 * and which models it may serve.
 *
 * Every consumer reads this file. No consumer parses a wrapper script, infers a harness from a
 * filename prefix, or consults a hardcoded model table. Two properties make that safe:
 *
 * 1. **An opaque `id` is the only join key.** `wrapper`, `home` and `displayName` are attributes.
 *    Renaming any of them leaves the id — and therefore every cross-subsystem join — untouched.
 * 2. **Availability is declared, so an unavailable model is unrepresentable as a selection.**
 *    `available: false` demands a reason, an unavailable account offers no default, and
 *    `defaultModel` must name a model this account declares available. A configuration that says
 *    a model is down can therefore never produce a manifest that offers or defaults to it.
 */
import { basename } from 'node:path';
import { z } from 'zod';
import { malformedSecretReference, secretReferencesIn } from '@ferretry/protocol';

const NonEmptyString = z.string().min(1);

/**
 * A value in an account's `secretEnv`: a template that names at least one secret and nothing that
 * merely looks like one.
 *
 * THE RULE IS THE POINT. `secretEnv` is published in a file that travels with a host's fleet, so a
 * literal accepted here would be a credential in a published document — the exact failure the whole
 * secret subsystem exists to make unrepresentable. Requiring a reference means the worst a malformed
 * entry can do is refuse the manifest, and a manifest that refuses is a fleet somebody fixes rather
 * than a key somebody has already copied.
 */
const SecretTemplateSchema = NonEmptyString.check(ctx => {
  const malformed = malformedSecretReference(ctx.value);
  if (malformed !== undefined) {
    ctx.issues.push({ code: 'custom', message: `"${malformed}" is not a secret reference`, input: ctx.value });
    return;
  }
  if (secretReferencesIn(ctx.value).length === 0) {
    ctx.issues.push({
      code: 'custom',
      message: 'a secretEnv value must name at least one secret; it may never carry a value',
      input: ctx.value,
    });
  }
});

/** Opaque, stable, per-account identity. The only key any consumer may join on. */
export const AccountIdSchema = z.uuid();
export type AccountId = z.infer<typeof AccountIdSchema>;

/** The agent harness an account drives. */
export const HarnessKindSchema = z.enum(['claude', 'codex']);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/**
 * The lane an account runs in. Declared, never derived from a name: an account whose wrapper is
 * literally called `auto-something` is not automatically an `auto` lane, and renaming a lane never
 * silently empties a caller's selection.
 */
export const AccountModeSchema = z.enum(['interactive', 'auto']);
export type AccountMode = z.infer<typeof AccountModeSchema>;

/**
 * One model an account may be asked to serve. `available` is mandatory and explicit — there is no
 * "probably fine" default — and an unavailable entry must say why.
 */
export const FleetManifestModelSchema = z.discriminatedUnion('available', [
  z.strictObject({
    id: NonEmptyString,
    displayName: NonEmptyString.optional(),
    available: z.literal(true),
  }),
  z.strictObject({
    id: NonEmptyString,
    displayName: NonEmptyString.optional(),
    available: z.literal(false),
    unavailableReason: NonEmptyString,
  }),
]);
export type FleetManifestModel = z.infer<typeof FleetManifestModelSchema>;

const accountShape = {
  id: AccountIdSchema,
  kind: HarnessKindSchema,
  mode: AccountModeSchema,
  /**
   * ABSOLUTE PATH of the executable provisioning generated for this account, not a bare name.
   *
   * A consumer must be able to launch an account without knowing where wrappers live, and — the
   * reason this is a path rather than a name — without a `PATH` that happens to contain the fleet's
   * bin directory. A daemon started by a service manager inherits no shell profile, so a name-based
   * lookup of a wrapper under `<FY_HOME>/fleet/bin` cannot resolve there however correctly the fleet
   * was provisioned. {@link wrapperName} is the one sanctioned way to recover the name from it.
   */
  wrapper: NonEmptyString,
  /** Absolute path of the harness config directory this account owns. */
  home: NonEmptyString,
  displayName: NonEmptyString,
  /** Model this account serves when a caller names none. `null` when it names none. */
  defaultModel: NonEmptyString.nullable(),
  models: z.array(FleetManifestModelSchema).readonly(),
  available: z.boolean(),
  /** Required when `available` is false, `null` otherwise. */
  unavailableReason: NonEmptyString.nullable(),
  /**
   * The environment variables a profile binds to Ferretry's secret store, as `${secret:NAME}`
   * templates. REFERENCES, NEVER VALUES — the store holds the values and the daemon puts them into
   * the launch environment; see `./env-profiles.ts` and `docs/secrets.md`.
   *
   * It is published here, on the record every consumer already reads, so that starting a session
   * does not have to read the fleet CONFIGURATION as well. That is not tidiness: a configuration
   * with a typo in it would otherwise refuse every session start on a host whose wrappers are
   * perfectly good, and the manifest is regenerated by the same apply that writes those wrappers, so
   * it cannot describe an account the wrappers do not.
   *
   * Empty for every account that authenticates any other way, which is the default and the
   * overwhelming case — a fleet that uses no profile publishes `{}` everywhere and nothing reads it.
   */
  secretEnv: z.record(NonEmptyString, SecretTemplateSchema).default({}),
};

/**
 * Cross-field consistency for one account. These are the rules that make the availability
 * contradiction found in the source configuration impossible to express.
 */
export const FleetManifestAccountSchema = z.strictObject(accountShape).check(ctx => {
  const account = ctx.value;

  if (account.available && account.unavailableReason !== null) {
    ctx.issues.push({
      code: 'custom',
      message: 'an available account must not carry an unavailableReason',
      input: account.unavailableReason,
      path: ['unavailableReason'],
    });
  }
  if (!account.available && account.unavailableReason === null) {
    ctx.issues.push({
      code: 'custom',
      message: 'an unavailable account must state an unavailableReason',
      input: account.unavailableReason,
      path: ['unavailableReason'],
    });
  }

  const seen = new Set<string>();
  account.models.forEach((model, index) => {
    if (seen.has(model.id)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate model "${model.id}"`,
        input: model.id,
        path: ['models', index, 'id'],
      });
    }
    seen.add(model.id);
  });

  if (account.available && account.defaultModel === null) {
    ctx.issues.push({
      code: 'custom',
      message: 'an available account must name a defaultModel',
      input: account.defaultModel,
      path: ['defaultModel'],
    });
    return;
  }

  if (account.defaultModel === null) return;

  const chosen = account.models.find(model => model.id === account.defaultModel);
  if (!chosen) {
    ctx.issues.push({
      code: 'custom',
      message: `defaultModel "${account.defaultModel}" is not one of this account's models`,
      input: account.defaultModel,
      path: ['defaultModel'],
    });
    return;
  }
  if (!chosen.available) {
    ctx.issues.push({
      code: 'custom',
      message: `defaultModel "${account.defaultModel}" is declared unavailable (${chosen.unavailableReason})`,
      input: account.defaultModel,
      path: ['defaultModel'],
    });
  }
});
export type FleetManifestAccount = z.infer<typeof FleetManifestAccountSchema>;

/** Bumped only when the on-disk shape changes incompatibly. */
export const MANIFEST_VERSION = 1 as const;

const duplicates = <T>(values: readonly T[]): T[] => {
  const seen = new Set<T>();
  const repeated = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
};

export const FleetManifestSchema = z
  .strictObject({
    version: z.literal(MANIFEST_VERSION),
    /** When provisioning produced this manifest, as an ISO-8601 instant. */
    generatedAt: z.iso.datetime(),
    accounts: z.array(FleetManifestAccountSchema).readonly(),
  })
  .check(ctx => {
    const { accounts } = ctx.value;

    for (const [field, message] of [
      ['id', 'account id'],
      ['wrapper', 'wrapper name'],
      ['home', 'home directory'],
    ] as const) {
      for (const repeated of duplicates(accounts.map(account => account[field]))) {
        ctx.issues.push({
          code: 'custom',
          message: `duplicate ${message} "${repeated}" — every account needs its own`,
          input: repeated,
          path: ['accounts'],
        });
      }
    }
  });
export type FleetManifest = z.infer<typeof FleetManifestSchema>;

/** What a caller hands to {@link buildFleetManifest}; the version is supplied for them. */
export interface FleetManifestInput {
  readonly generatedAt: string;
  readonly accounts: readonly unknown[];
}

/**
 * Parse a manifest from untrusted input, so downstream code holds a `FleetManifest` rather than a
 * promise that one was checked. Throws on any inconsistency.
 */
export function buildFleetManifest(input: FleetManifestInput): FleetManifest {
  return FleetManifestSchema.parse({
    version: MANIFEST_VERSION,
    generatedAt: input.generatedAt,
    accounts: input.accounts,
  });
}

/**
 * The executable NAME this account publishes — the word an operator types and a session record
 * carries, taken from the published path rather than reassembled from a configuration.
 *
 * Publishing both a name and a path would be two spellings of one fact, and the pair that could
 * disagree is exactly the class of defect this manifest exists to remove. So the path is published
 * and the name is derived here, once, for every consumer that needs to say which account something
 * ran as. It is not a meaning read out of a name: nothing downstream may infer an account's harness,
 * lane or model from this string — {@link FleetManifestAccount.kind} and its siblings declare those.
 */
export function wrapperName(account: FleetManifestAccount): string {
  return wrapperNameOf(account.wrapper);
}

/**
 * The same derivation, for a caller that holds the published PATH rather than the whole account.
 *
 * One owner for one rule. An identity member and a usage row both carry a wrapper and neither is a
 * {@link FleetManifestAccount}, and a second `basename` call elsewhere is how two consumers come to
 * disagree about what an account is called on a host whose separator is not the one they assumed.
 */
export function wrapperNameOf(publishedPath: string): string {
  return basename(publishedPath);
}

/** Model ids this account may actually be asked to serve. Never includes an unavailable model. */
export function selectableModelIds(account: FleetManifestAccount): readonly string[] {
  if (!account.available) return [];
  return account.models.filter(model => model.available).map(model => model.id);
}

/** Whether `modelId` may be routed to `account`. The only sanctioned selection check. */
export function isModelSelectable(account: FleetManifestAccount, modelId: string): boolean {
  return selectableModelIds(account).includes(modelId);
}

/** Accounts that can serve work right now, in manifest order. */
export function availableAccounts(manifest: FleetManifest): readonly FleetManifestAccount[] {
  return manifest.accounts.filter(account => account.available);
}

/** Look an account up by its only legitimate join key. */
export function findAccountById(manifest: FleetManifest, id: string): FleetManifestAccount | undefined {
  return manifest.accounts.find(account => account.id === id);
}
