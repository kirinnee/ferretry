/**
 * What a browser may know about the profiles a fleet declares, and what it may ask for one.
 *
 * A profile can authenticate an account **instead of a login** — `docs/fleet-env-profiles.md` is the
 * contract and this file adds nothing to it. What it adds is a WIRE SHAPE, because the surface that
 * offers a profile is in a browser and every fact it needs is a fact only the host can answer.
 *
 * ## Shapes, never values
 *
 * `docs/secrets.md` is "use, never read", and the read half of this contract obeys it structurally:
 * {@link FleetEnvValueShapeSchema} has no field a value could travel in. A variable is a `literal`
 * with **no text at all**, an `environment-reference` naming the variable it reads, or a `secret`
 * naming the secrets it binds. That is the same three-way answer `envComposition` gives on the host,
 * and the reason the `literal` arm is empty is the reason it is empty there: most literals are
 * harmless, some are not, and there is no rule deciding which that stays right.
 *
 * A NAME IS NOT A VALUE, and this is where somebody will get it wrong in both directions. `WORK_KEY`
 * is safe to render — it is what the fleet configuration itself carries, and a person who cannot see
 * it cannot fix an account that reaches for a secret nobody has set. The sixty characters the store
 * holds under that name reach exactly one place, which is the environment of the child launched for
 * one account, and no schema in this package has anywhere to put one.
 *
 * ## The write half declares, it does not spell
 *
 * {@link FleetProfileVariableDeclarationSchema} is a discriminated union of the three spellings rather
 * than a free string, and that is a deliberate narrowing of what a browser can say. A caller that
 * could send `env` as text could send `${secret:work_key}` — a near miss the grammar does not match,
 * so it would stay a literal, be exported into a child verbatim, and authenticate with the eighteen
 * characters of the reference itself. Naming the secret in its own field makes that unsayable, and the
 * host composes the spelling with `secretReference` so there is one producer of it.
 *
 * A `value` entry is what a plain setting is for — a base URL, a region, a model default. It is a
 * literal in the fleet configuration and the generated wrapper exports it as one, so it is exactly
 * the wrong place for a credential; the surface that offers it says so, and the read half above will
 * never show it back.
 */
import { z } from 'zod';
import { SecretNameSchema } from './secrets.ts';

const NonEmpty = z.string().min(1);

/**
 * An environment variable name, checked for shape and nothing else.
 *
 * The RESERVED names — `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CODEX_SQLITE_HOME` — are refused by the
 * fleet's own `EnvSchema`, by name, because a profile that set one could point an account at another
 * account's credential. That refusal is deliberately not restated here: it names the offending
 * variable in a sentence a person reads, and a second copy of the list would be the one that went
 * stale the day a third harness arrived.
 */
export const FleetEnvVariableSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'an environment variable name is letters, digits and underscores');

/**
 * WHAT A COMPOSED VARIABLE IS, without saying what it holds.
 *
 * Three arms because there are three places a value can be when the wrapper runs, and a person acting
 * on one acts differently on each: a secret is set with `fy secret set`, an environment reference is
 * set by whatever launches the wrapper, and a literal is already in the fleet configuration.
 */
export const FleetEnvValueShapeSchema = z.discriminatedUnion('shape', [
  z.strictObject({ shape: z.literal('literal') }),
  z.strictObject({ shape: z.literal('environment-reference'), variable: FleetEnvVariableSchema }),
  z.strictObject({
    shape: z.literal('secret'),
    /** Every secret this one variable names, in first-appearance order. Never empty. */
    secrets: z.array(SecretNameSchema).min(1).readonly(),
  }),
]);
export type FleetEnvValueShape = z.infer<typeof FleetEnvValueShapeSchema>;

/**
 * One variable a profile sets, and where its value will come from.
 *
 * `harness` is present only for a variable a profile sets through its `claude:` / `codex:` overlay,
 * and absent for one it sets flatly. Both are reported, even when they name the same variable, because
 * within one slot the overlay beats the flat field — so a reader filtering to their own harness sees
 * the entry that will actually apply, and a reader of the other harness sees the one that will apply
 * to them. Collapsing the two would have to choose, and either choice is wrong for somebody.
 */
export const FleetProfileVariableSchema = z.strictObject({
  variable: FleetEnvVariableSchema,
  shape: FleetEnvValueShapeSchema,
  harness: z.enum(['claude', 'codex']).optional(),
});
export type FleetProfileVariable = z.infer<typeof FleetProfileVariableSchema>;

/**
 * One declared profile, as a surface that offers it needs to see it.
 *
 * `authenticates` is the field that makes "no login" a real answer rather than a hopeful one. A
 * profile that sets a harness's credential variable authenticates an account of that harness: there
 * is nothing to sign in to, and the daemon supplies the value at launch. A profile that sets only a
 * base URL does NOT, and an account bound to it still needs its login — so a surface that offered
 * "no login needed" for one would be sending somebody to an account that cannot start. It is
 * per-harness because the variables are: `ANTHROPIC_API_KEY` authenticates Claude and says nothing
 * about Codex.
 *
 * `accounts` is the fact that makes a shared thing safe to reason about — it answers "what else
 * changes if I edit this" before somebody edits it — and it is wrapper NAMES rather than a count for
 * the same reason the sharing report carries them: "used by claude-studio" is what a person acts on.
 */
export const FleetProfileViewSchema = z.strictObject({
  name: NonEmpty,
  /**
   * True for the one profile every account composes before its own, which the fleet names `base`.
   *
   * It is reported rather than filtered out, because a surface that hid it would be showing a
   * composition with its first slot missing — and the whole point of showing the order is that the
   * value which wins is the one a person can predict.
   */
  appliesToEveryAccount: z.boolean(),
  /** In sorted variable order, so two hosts that declared the same profile report the same list. */
  variables: z.array(FleetProfileVariableSchema).readonly(),
  /** Wrappers whose account already composes this profile, in fleet order. */
  accounts: z.array(NonEmpty).readonly(),
  /** Harnesses whose credential variable this profile sets. Empty means it authenticates nothing. */
  authenticates: z.array(z.enum(['claude', 'codex'])).readonly(),
});
export type FleetProfileView = z.infer<typeof FleetProfileViewSchema>;

/**
 * Every profile this fleet declares, and the variables that stand in for a login.
 *
 * `credentialVariables` is carried rather than left to the client because it is the HOST's list —
 * `HARNESS_CREDENTIAL_ENV`, the same one `credentialSourceOf` reads to decide whether a login applies.
 * A browser that hard-coded `ANTHROPIC_API_KEY` would be a second copy of it, and the way a second copy
 * fails is by offering a form that composes a profile the host does not consider a credential at all.
 *
 * An empty `profiles` list is an ordinary fleet rather than a broken one: a profile is opt-in, and most
 * accounts authenticate by signing in.
 */
export const FleetProfileCatalogSchema = z.strictObject({
  profiles: z.array(FleetProfileViewSchema).readonly(),
  credentialVariables: z.strictObject({
    claude: z.array(FleetEnvVariableSchema).readonly(),
    codex: z.array(FleetEnvVariableSchema).readonly(),
  }),
});
export type FleetProfileCatalog = z.infer<typeof FleetProfileCatalogSchema>;

/**
 * One variable a caller asks a NEW profile to set, in the spelling it means.
 *
 * See this file's header for why this is a union rather than a string. `secret` names a secret in this
 * daemon's store — which need not exist yet, because declaring the account and setting the credential
 * are two acts by two people often enough that requiring the order would be a refusal nobody needs;
 * the secret listing says `resolved: false` until somebody sets it, and a launch refuses by name.
 */
export const FleetProfileVariableDeclarationSchema = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('secret'), variable: FleetEnvVariableSchema, secret: SecretNameSchema }),
  z.strictObject({
    from: z.literal('environment'),
    variable: FleetEnvVariableSchema,
    /** The variable the wrapper reads it out of, which is usually but not always the same name. */
    source: FleetEnvVariableSchema,
  }),
  z.strictObject({ from: z.literal('value'), variable: FleetEnvVariableSchema, value: NonEmpty }),
]);
export type FleetProfileVariableDeclaration = z.infer<typeof FleetProfileVariableDeclarationSchema>;

/**
 * A profile this change declares, which every later account can then pick.
 *
 * Non-empty, because a profile that sets nothing composes nothing: it would be a name in the
 * configuration that no account could be authenticated by, and the surface that offered it would be
 * offering an answer with no effect.
 */
export const FleetProfileDeclarationSchema = z.strictObject({
  name: NonEmpty,
  variables: z.array(FleetProfileVariableDeclarationSchema).min(1).readonly(),
});
export type FleetProfileDeclaration = z.infer<typeof FleetProfileDeclarationSchema>;
