/**
 * Runtimes' configuration files (§9.2): `runtimes.yaml` (the default runtime), `runtimes/<name>.yaml`,
 * `profiles/<name>.yaml` and `model-sets/<name>.yaml`. Schemas are today's (`RuntimeSchema`, `ProfileFileSchema`,
 * `ModelSetComponentSchema`, the machine's `defaultRuntime`), with the words of §1: a runtime names a **login**, not a
 * credential. Every file is strict; a raw secret never belongs in one (the kernel's config layer refuses it).
 */
import { InstantSchema, NonEmptyStringSchema } from '@ferretry/std';
import { z } from 'zod';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';

/** A runtime's name: letters, digits and dashes, none at either end (R1). It is the CLI word a person types. */
export const RuntimeNameSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u, {
    message: 'use only letters, digits and dashes, starting and ending with a letter or digit',
  });

/** A login's id as a runtime names it (Logins owns the grammar: lowercase letters, digits, dashes). */
export const LoginRefSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/u, 'a login id uses only lowercase letters, digits and dashes');

/** A component's or profile's name: one path segment. */
export const ItemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(value => !/[/\\]/u.test(value) && !value.includes('..') && value.trim() === value, {
    message: 'a name is one word or phrase with no slash',
  });

/** The six component kinds a profile layer may name, as the configuration spells them. */
export const COMPONENT_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets'] as const;
export type LayerComponentKind = (typeof COMPONENT_KINDS)[number];
export const PROFILE_LAYER_PREFIX = 'profile' as const;

const LAYER_KINDS: readonly string[] = [...COMPONENT_KINDS, PROFILE_LAYER_PREFIX];

/** A layer reference as written: `<kind>/<name>` for a component, `profile/<name>` for a base profile. */
export const LayerReferenceSchema = z.string().check(ctx => {
  const separator = ctx.value.indexOf('/');
  const kind = separator < 0 ? '' : ctx.value.slice(0, separator);
  const name = separator < 0 ? '' : ctx.value.slice(separator + 1);
  if (!LAYER_KINDS.includes(kind) || !ItemNameSchema.safeParse(name).success)
    ctx.issues.push({
      code: 'custom',
      message: `"${ctx.value}" is not a layer — write <kind>/<name> with kind one of ${COMPONENT_KINDS.join(', ')}, or profile/<name>`,
      input: ctx.value,
    });
});

/** `auto`, or a token count at or above the floor (docs/compact-at.md). */
export const COMPACT_AT_MIN_TOKENS = 100_000;
export const CompactAtSchema = z.union([
  z.literal('auto'),
  z
    .number()
    .int()
    .min(COMPACT_AT_MIN_TOKENS, `Compact memory at ${COMPACT_AT_MIN_TOKENS / 1000}k tokens or more.`),
]);

/**
 * `disabled:` on a runtime file (docs/disabling.md). `until` is an instant or a calendar date (the START of that day
 * in UTC); once it has passed the block is gone with no edit.
 */
export const DisabledConfigSchema = z.strictObject({
  reason: z.string().trim().min(1).max(200).optional(),
  until: z
    .string()
    .refine(value => InstantSchema.safeParse(value).success || z.iso.date().safeParse(value).success, {
      message: 'write "until" as a date (2026-11-01) or a time (2026-11-01T09:00:00Z)',
    })
    .optional(),
});
export type DisabledConfig = z.infer<typeof DisabledConfigSchema>;

/** `config/runtimes.yaml`: the one runtime a start uses when nobody names one. */
export const RuntimesFileSchema = z.strictObject({
  defaultRuntime: RuntimeNameSchema.optional(),
});
export type RuntimesFile = z.infer<typeof RuntimesFileSchema>;

/** `config/runtimes/<name>.yaml`: one login and one profile, launched under the file's name (R1). */
export const RuntimeFileSchema = z.strictObject({
  login: LoginRefSchema,
  profile: ItemNameSchema,
  /** For a login that drives both harnesses: which one this runtime runs. Left out: the profile's, else the login's. */
  harness: HarnessKeySchema.optional(),
  /** "Ferretry launches this as an agent" (R3): only these get the fixed layer and start unattended. */
  agent: z.boolean().default(false),
  disabled: DisabledConfigSchema.optional(),
  compactAt: CompactAtSchema.optional(),
  /** The source's origin key for this runtime, set by Clone: how a repeat copy finds it again. */
  clonedFromKey: NonEmptyStringSchema.optional(),
});
export type RuntimeFile = z.infer<typeof RuntimeFileSchema>;

/** `config/profiles/<name>.yaml`: an ordered stack of layers, OLDEST FIRST; a newer layer overrides an older one (P2). */
export const ProfileFileSchema = z.strictObject({
  contents: z.array(LayerReferenceSchema).default([]),
  compactAt: CompactAtSchema.optional(),
  clonedFromKey: NonEmptyStringSchema.optional(),
});
export type ProfileFile = z.infer<typeof ProfileFileSchema>;

/** `config/model-sets/<name>.yaml`: model ids and the one a runtime uses when nobody names one (K2, K8). */
export const ModelSetFileSchema = z
  .strictObject({
    models: z.array(NonEmptyStringSchema).min(1),
    default: NonEmptyStringSchema,
    clonedFrom: NonEmptyStringSchema.optional(),
    clonedFromDaemon: NonEmptyStringSchema.optional(),
    clonedFromKey: NonEmptyStringSchema.optional(),
  })
  .check(ctx => {
    const set = ctx.value;
    const seen = new Set<string>();
    set.models.forEach((model, index) => {
      if (seen.has(model))
        ctx.issues.push({
          code: 'custom',
          message: `model "${model}" is listed twice`,
          input: model,
          path: ['models', index],
        });
      seen.add(model);
    });
    if (!set.models.includes(set.default))
      ctx.issues.push({
        code: 'custom',
        message: `default "${set.default}" is not one of this model set's models (${set.models.join(', ')})`,
        input: set.default,
        path: ['default'],
      });
  });
export type ModelSetFile = z.infer<typeof ModelSetFileSchema>;

// ─── loosening (§7.2) ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Today's `runtimeLoosening` sentence, pure. A budget counts the spend of the runtimes on its login and stops their
 * ferrets, so moving a runtime off a budgeted login (re-pointed, or deleted: `after` undefined) takes its spend and its
 * running ferrets out of the budget's reach. `budgeted` is the lookup of Logins' budgets, supplied by the daemon half (a
 * contract here may not import Logins), so this stays pure.
 */
export function runtimeLoosening(
  name: string,
  before: Pick<RuntimeFile, 'login'> | undefined,
  after: Pick<RuntimeFile, 'login'> | undefined,
  budgeted: (login: string) => boolean,
): readonly string[] {
  if (before === undefined || !budgeted(before.login) || after?.login === before.login) return [];
  return [
    after === undefined
      ? `runtime "${name}" is removed from login "${before.login}", whose budget counts and stops it`
      : `runtime "${name}" moves off login "${before.login}", whose budget counts and stops it, to "${after.login}"`,
  ];
}

/**
 * The `loosens` the kernel's config layer calls with (before, after) only. It cannot see a budget, so it FAILS CLOSED:
 * any change of login is reported as a possible loosening (the owner confirms it); the daemon half refines it with
 * {@link runtimeLoosening} and the real lookup. A new file loosens nothing (a runtime nobody had counted for nothing).
 */
export const runtimeFileLoosens = (before: RuntimeFile | undefined, after: RuntimeFile): readonly string[] =>
  before === undefined || before.login === after.login
    ? []
    : [
        `a runtime moves off login "${before.login}" to "${after.login}", which may leave a budget that counts and stops it`,
      ];
