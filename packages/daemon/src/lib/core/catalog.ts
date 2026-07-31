/**
 * The routing catalog: which models exist, what each is good at, and which accounts may serve them.
 *
 * This is **data supplied to the engine**, not knowledge baked into it. The source hardcoded the
 * same facts in four separate tables — a runtime model allowlist, a wrapper→model alias map, a
 * recommendation allowlist with bans, and a third regex table for display — with nothing forcing
 * them to agree. They did not: one declared a model down while another still ranked it the default
 * recommendation, so work was confidently routed to a model that could not serve it.
 *
 * Two changes make that unrepresentable here. Accounts are named by their stable id rather than
 * matched with a regex over an executable name, and the doctrine's capability floors are numbers in
 * the catalog rather than references to particular models inside the algorithm — the engine no
 * longer knows any model by name, so a catalog missing one cannot crash or silently skew it.
 */
import { z } from 'zod';
import { complexities, taskKinds, teamRoles, type Complexity, type TaskKind, type TeamRole } from './classification.ts';

const NonEmptyString = z.string().min(1);
const Power = z.number().finite().min(0).max(100);
const Score = z.number().finite().min(0).max(100);

export const ModelCostSchema = z.enum(['low', 'medium', 'high', 'very-high']);
export type ModelCost = z.infer<typeof ModelCostSchema>;

export const ModelSpeedSchema = z.enum(['fastest', 'fast', 'medium', 'slow']);
export type ModelSpeed = z.infer<typeof ModelSpeedSchema>;

/** Roles a model is scored for directly. Implementer fitness is complexity-relative instead. */
const scoredRoles = teamRoles.filter((role): role is Exclude<TeamRole, 'implementer'> => role !== 'implementer');

export const RoutingModelSchema = z.strictObject({
  /** Catalog-local key an account's options refer to. */
  id: NonEmptyString,
  label: NonEmptyString,
  family: z.enum(['claude', 'codex']),
  tier: NonEmptyString,
  speed: ModelSpeedSchema,
  cost: ModelCostSchema,
  /** The doctrine's tiers as one number, so a capability floor is expressible. */
  power: Power,
  /** Per-role base score. An absent or zero role means "never as primary for that role". */
  roleScore: z.partialRecord(z.enum(scoredRoles), Score).default({}),
  /**
   * Implementer fitness is complexity-relative, never absolute. A single "best implementer" number
   * put the top tier on a mass rename and on a stylesheet tweak alike: it is the right answer for
   * the hardest work and the wrong answer for a chore.
   */
  implementerFit: z.record(z.enum(complexities), Score),
  /** Per-kind bonus for a specialist, so a specialism lives in the catalog and not in the engine. */
  kindAffinity: z.partialRecord(z.enum(taskKinds), z.number().finite().min(-100).max(100)).default({}),
  /** Doctrine: never let this model lead product-facing work. */
  noProductFacing: z.boolean().default(false),
  /** Doctrine: may implement only from a plan written by a more capable model. */
  needsPlan: z.boolean().default(false),
  note: NonEmptyString,
});
export type RoutingModel = z.infer<typeof RoutingModelSchema>;

export const RoutingAccountOptionSchema = z.strictObject({
  /** A {@link RoutingModel.id}. */
  model: NonEmptyString,
  /** The `--model` value needed to reach it; absent means the account's own default. */
  modelFlag: NonEmptyString.optional(),
});
export type RoutingAccountOption = z.infer<typeof RoutingAccountOptionSchema>;

export const RoutingAccountSchema = z.strictObject({
  /** Joins the inventory's opaque account id — never an executable name. */
  accountId: NonEmptyString,
  /** Accounts the operator wants spend concentrated on. */
  preferredSpend: z.boolean().default(false),
  /** Present means never recommend, with this reason shown in the exclusions list. */
  excludedReason: NonEmptyString.optional(),
  options: z.array(RoutingAccountOptionSchema).readonly().default([]),
});
export type RoutingAccount = z.infer<typeof RoutingAccountSchema>;

/**
 * The doctrine's capability floors, as plain numbers on the same scale as {@link RoutingModel.power}.
 * The source spelled these as references to specific catalog entries, which coupled the algorithm
 * to a particular fleet and threw when that fleet changed.
 */
export const RoutingFloorsSchema = z.strictObject({
  planner: Power,
  reviewer: Power,
  /** Hard work that is also critical or large: the top tier only. */
  hardAndDemanding: Power,
  /** Hard or critical work. */
  hardOrCritical: Power,
  /** Ordinary mid-complexity work. */
  mid: Power,
  /** Raised floor when the caller buys quality; never applied to mechanical work. */
  qualityFirst: Power,
});
export type RoutingFloors = z.infer<typeof RoutingFloorsSchema>;

export const RoutingWeightsSchema = z.strictObject({
  /** Bonus for an account the operator wants spend concentrated on. */
  preferredSpendBonus: z.number().finite().default(6),
  /** Bonus for reaching a model through an account's own default rather than an override flag. */
  accountDefaultBonus: z.number().finite().default(2),
  /** How hard a spent account is pushed down; the divisor is applied to its spent percentage. */
  spentPercentDivisor: z.number().finite().positive().default(8),
  /**
   * What to assume about an account the feed cannot score — one it has never seen, or one whose
   * probe failed.
   *
   * It must not be zero. Zero is the *best* possible reading, so the source's `usageScore(undefined)
   * === 0` made every unmeasured account outrank every measured one, and a failed collection
   * promoted the account it failed on. It must not be 100 either, which buries a freshly added
   * account under an almost-exhausted one. The midpoint says only what is true: nothing is known,
   * so assume it is ordinary.
   */
  unknownSpentPercent: Power.default(50),
  /** Penalty applied to a plan-following implementer when the caller is buying cheap. */
  needsPlanCheapPenalty: z.number().finite().default(25),
  /** Penalty for a below-top-tier researcher on large-scope work. */
  smallResearcherPenalty: z.number().finite().default(20),
  /** The power below which a researcher counts as small for the penalty above. */
  researcherReachFloor: Power.default(90),
  /** How many alternatives to keep per role. */
  alternativesShown: z.number().int().min(0).max(10).default(3),
});
export type RoutingWeights = z.infer<typeof RoutingWeightsSchema>;

const CostPenaltySchema = z.partialRecord(ModelCostSchema, z.number().finite().min(0));

export const RoutingCatalogSchema = z
  .strictObject({
    models: z.array(RoutingModelSchema).min(1),
    accounts: z.array(RoutingAccountSchema).default([]),
    floors: RoutingFloorsSchema,
    weights: RoutingWeightsSchema.prefault({}),
    /** Steep on purpose: a cost-first caller must be able to change the answer, not just the order. */
    costPenalty: z.partialRecord(z.enum(['cheap', 'balanced', 'max']), CostPenaltySchema),
  })
  .check(context => {
    const catalog = context.value;
    const modelIds = new Set<string>();
    for (const model of catalog.models) {
      if (modelIds.has(model.id))
        context.issues.push({ code: 'custom', input: model.id, message: `duplicate model id "${model.id}"` });
      modelIds.add(model.id);
    }
    const accountIds = new Set<string>();
    for (const account of catalog.accounts) {
      if (accountIds.has(account.accountId))
        context.issues.push({
          code: 'custom',
          input: account.accountId,
          message: `duplicate routing entry for account "${account.accountId}"`,
        });
      accountIds.add(account.accountId);
      for (const option of account.options) {
        if (!modelIds.has(option.model))
          context.issues.push({
            code: 'custom',
            input: option.model,
            message: `account "${account.accountId}" offers unknown model "${option.model}"`,
          });
      }
    }
  });
export type RoutingCatalog = z.infer<typeof RoutingCatalogSchema>;
export type RoutingCatalogInput = z.input<typeof RoutingCatalogSchema>;

/** Parse a catalog from configuration. Cross-references are checked here, not discovered at use. */
export function parseRoutingCatalog(input: unknown): RoutingCatalog {
  return RoutingCatalogSchema.parse(input);
}

/** An index over a parsed catalog, so lookups are by id rather than a scan per candidate. */
export interface RoutingIndex {
  readonly catalog: RoutingCatalog;
  model(id: string): RoutingModel | undefined;
  account(accountId: string): RoutingAccount | undefined;
}

export function indexCatalog(catalog: RoutingCatalog): RoutingIndex {
  const models = new Map(catalog.models.map(model => [model.id, model]));
  const accounts = new Map(catalog.accounts.map(account => [account.accountId, account]));
  return {
    catalog,
    model: id => models.get(id),
    account: accountId => accounts.get(accountId),
  };
}

/** The base score a model carries for a role, before any adjustment. Zero means never as primary. */
export function baseRoleScore(model: RoutingModel, role: TeamRole, complexity: Complexity): number {
  if (role === 'implementer') return model.implementerFit[complexity] ?? 0;
  return model.roleScore[role as Exclude<TeamRole, 'implementer'>] ?? 0;
}

/** The bonus a specialist model carries for a kind of work. */
export function kindBonus(model: RoutingModel, kind: TaskKind): number {
  return model.kindAffinity[kind] ?? 0;
}
