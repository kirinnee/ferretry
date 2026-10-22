/**
 * A MODEL CATALOG (docs/model-catalog.md): the models one provider serves to Claude Code and to Codex,
 * each with the words a picker shows — a label, a tier, the context window, the reasoning efforts it
 * takes — and, for Claude Code, which of them fills each of Claude Code's tier slots
 * (`/model opus|sonnet|haiku`).
 *
 * A catalog is DATA, never a credential and never a permission: labels, model ids and tiers. A login
 * names one through its preset (`catalog:`), a sign-in login through its CLI (`anthropic`, `openai`),
 * and what a runtime on that login offers and launches with is derived from it at apply time
 * (`./runtime.ts`).
 *
 * Three copies of a catalog may exist, and the newest-owned wins (`./catalog.ts`): the machine's own
 * `config/models/<id>.yaml`, the signed catalog Ferretry publishes, and the one compiled into this
 * build. All three have this one shape.
 *
 * Pure.
 */
import { AnalyticsPricingProviderSchema, AnalyticsPricingSourceUrlSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { HarnessKind } from '../manifest.ts';

const Text = z.string().min(1).max(600);
const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A model id as a CLI takes it after `--model` or `/model`: no whitespace or shell metacharacter, so a
 * picker can type it into a pane and a wrapper can pass it as one argument.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}$/u;
export const ModelIdSchema = z
  .string()
  .regex(MODEL_ID_PATTERN, { message: 'a model id is letters, digits and . _ : ~ / @ + -, without spaces' });

/** The same, with Claude Code's optional context suffix (`deepseek-flash[1m]`), as a tier slot holds it. */
const SlotValueSchema = z.string().regex(/^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}(?:\[[a-z0-9]{1,8}\])?$/u, {
  message: 'a tier slot holds a model id, optionally with a context suffix such as [1m]',
});

/** Where a model sits in a picker: the most capable, the everyday one, the quick one. */
export const ModelTierSchema = z.enum(['best', 'balanced', 'fast']);
export type ModelTier = z.infer<typeof ModelTierSchema>;
export const MODEL_TIERS: readonly ModelTier[] = ModelTierSchema.options;

/** A reasoning effort a CLI accepts (`/effort high`, `model_reasoning_effort = "high"`). */
const EffortSchema = z.string().regex(/^[a-z]{2,12}$/u);

/**
 * US dollars per million tokens, to the micro-dollar: the denomination every provider's pricing page
 * uses, and the precision analytics stores a rate at (integer micros), so nothing is lost converting.
 */
const UsdPerMillionSchema = z
  .number()
  .nonnegative()
  .max(10_000)
  .refine(value => Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 1e-6, {
    message: 'a price is dollars per million tokens to at most six decimal places',
  });

/**
 * What a model costs, as its provider publishes it (docs/model-catalog.md § Prices): USD per million
 * tokens, the page it was read on and the day it was read. It prices an "equivalent API cost" in
 * analytics — what a session would have cost at list price — never a bill, and a subscription login
 * reads it as exactly that.
 *
 * `provider` is whose billing RULES the price follows (`@ferretry/protocol` analytics pricing): an
 * `anthropic` price charges a cache write by how long it is kept, so it states `cacheWrite5m` and
 * `cacheWrite1h`; every other maker charges one `cacheWrite`. `reasoning` is stated only where it
 * differs from `output`: every maker these catalogs price bills reasoning (thinking) tokens as output.
 */
export const CatalogPriceSchema = z
  .strictObject({
    provider: AnalyticsPricingProviderSchema,
    input: UsdPerMillionSchema,
    output: UsdPerMillionSchema,
    cacheRead: UsdPerMillionSchema,
    cacheWrite: UsdPerMillionSchema.optional(),
    cacheWrite5m: UsdPerMillionSchema.optional(),
    cacheWrite1h: UsdPerMillionSchema.optional(),
    reasoning: UsdPerMillionSchema.optional(),
    /** The provider's own pricing page, where these numbers were read: https, no credential, no fragment. */
    source: AnalyticsPricingSourceUrlSchema,
    /** When they were read there. */
    verified: z.string().regex(YYYY_MM_DD, { message: 'write the date as YYYY-MM-DD' }),
  })
  .check(ctx => {
    const price = ctx.value;
    const split = price.cacheWrite5m !== undefined || price.cacheWrite1h !== undefined;
    if (price.provider === 'anthropic' && (price.cacheWrite5m === undefined || price.cacheWrite1h === undefined)) {
      ctx.issues.push({
        code: 'custom',
        message:
          'an anthropic price states both cacheWrite5m and cacheWrite1h: Anthropic bills a cache write by its lifetime',
        input: price,
        path: ['cacheWrite5m'],
      });
    }
    if (price.provider !== 'anthropic' && split) {
      ctx.issues.push({
        code: 'custom',
        message: `a ${price.provider} price states one cacheWrite; only Anthropic splits cache writes by lifetime`,
        input: price,
        path: ['cacheWrite5m'],
      });
    }
    if (price.provider === 'anthropic' && price.cacheWrite !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'an anthropic price states cacheWrite5m and cacheWrite1h, not one cacheWrite',
        input: price.cacheWrite,
        path: ['cacheWrite'],
      });
    }
  });
export type CatalogPrice = z.infer<typeof CatalogPriceSchema>;

/** One model. `efforts` is empty for a model whose reasoning cannot be adjusted — no effort is offered. */
export const CatalogModelSchema = z
  .strictObject({
    id: ModelIdSchema,
    label: z.string().min(1).max(80),
    tier: ModelTierSchema,
    /**
     * Claude Code only: the context suffix it is given the model with (`[1m]`), where the provider says
     * to use one. Appended wherever Claude Code is handed this model: a picker, `--model`.
     */
    suffix: z
      .string()
      .regex(/^\[[a-z0-9]{1,8}\]$/u)
      .optional(),
    /** The context window, in tokens. */
    context: z.number().int().positive().max(100_000_000).optional(),
    /** Whether the model reasons (thinks) at all, adjustable or not. Implied by a non-empty `efforts`. */
    reasoning: z.boolean().optional(),
    /** The efforts it takes, lowest first, in the CLI's own words. */
    efforts: z.array(EffortSchema).default([]),
    /** The effort it runs at when nobody chooses one. */
    defaultEffort: EffortSchema.optional(),
    /** The one model a runtime on this catalog launches with when nobody names one. */
    default: z.boolean().default(false),
    /** One sentence a picker shows under the label. */
    note: Text.optional(),
    /** What it costs at list price, when the provider publishes one (`CatalogPriceSchema`). */
    price: CatalogPriceSchema.optional(),
    /** The day the provider retires it, when the provider has announced one. */
    retires: z.string().regex(YYYY_MM_DD, { message: 'write the date as YYYY-MM-DD' }).optional(),
  })
  .check(ctx => {
    const model = ctx.value;
    if (model.defaultEffort !== undefined && !model.efforts.includes(model.defaultEffort)) {
      ctx.issues.push({
        code: 'custom',
        message: `defaultEffort "${model.defaultEffort}" is not one of ${model.id}'s efforts`,
        input: model.defaultEffort,
        path: ['defaultEffort'],
      });
    }
    if (model.reasoning === false && model.efforts.length > 0) {
      ctx.issues.push({
        code: 'custom',
        message: `${model.id} lists efforts, so it reasons — drop "reasoning: false"`,
        input: model.reasoning,
        path: ['reasoning'],
      });
    }
  });
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/**
 * Claude Code's tier slots and the variable each is set through. `subagent` is the model Claude Code's
 * subagents run on. Pinned by Ferretry so `/model opus` lands on the catalog's model on every backend.
 */
export const CLAUDE_TIER_VARIABLES = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
} as const;
export type ClaudeTierSlot = keyof typeof CLAUDE_TIER_VARIABLES;
const ClaudeTiersSchema = z.strictObject({
  opus: SlotValueSchema.optional(),
  sonnet: SlotValueSchema.optional(),
  haiku: SlotValueSchema.optional(),
  subagent: SlotValueSchema.optional(),
});

/** A slot's value without its context suffix: the catalog id it names. */
export const slotModelId = (value: string): string => value.replace(/\[[^\]]*\]$/u, '');

/** One CLI's models in a catalog. */
export const CatalogHalfSchema = z
  .strictObject({
    /** This CLI's own page at the provider, when it has one apart from the catalog's `docs`. */
    docs: z.url().optional(),
    /** Claude Code only: the model each tier slot is pinned to. */
    tiers: ClaudeTiersSchema.optional(),
    models: z.array(CatalogModelSchema).min(1),
  })
  .check(ctx => {
    const half = ctx.value;
    const push = (message: string, path: readonly PropertyKey[], input: unknown): void => {
      ctx.issues.push({ code: 'custom', message, input, path: [...path] });
    };
    const ids = new Set<string>();
    half.models.forEach((model, index) => {
      if (ids.has(model.id)) push(`model "${model.id}" is listed twice`, ['models', index, 'id'], model.id);
      ids.add(model.id);
    });
    const defaults = half.models.filter(model => model.default);
    if (defaults.length !== 1) {
      push(
        defaults.length === 0
          ? 'mark exactly one model "default: true" — the one a runtime launches with'
          : `only one model may be the default; ${defaults.map(model => model.id).join(', ')} all say "default: true"`,
        ['models'],
        defaults.map(model => model.id),
      );
    }
    for (const [slot, value] of Object.entries(half.tiers ?? {})) {
      if (value !== undefined && !ids.has(slotModelId(value))) {
        push(
          `tier slot "${slot}" names ${value}, which is not one of this catalog's models (${[...ids].join(', ')})`,
          ['tiers', slot],
          value,
        );
      }
    }
  });
export type CatalogHalf = z.infer<typeof CatalogHalfSchema>;

/** A catalog file, as written. */
export const ModelCatalogFileSchema = z
  .strictObject({
    label: z.string().min(1).max(80),
    /** The provider's own model documentation. */
    docs: z.url(),
    /** When its facts were last checked against that documentation. */
    verified: z.string().regex(YYYY_MM_DD, { message: 'write the date as YYYY-MM-DD' }),
    /** Each fact that could not be confirmed there, in a sentence. */
    unverified: z.array(Text).default([]),
    /** Whether the provider serves ids beyond these, so a picker offers "Custom id…". */
    customIds: z.boolean().default(false),
    /** Where a picker may also read the models a local server reports it has. */
    detect: z.enum(['ollama']).optional(),
    claude: CatalogHalfSchema.optional(),
    codex: CatalogHalfSchema.optional(),
  })
  .check(ctx => {
    const catalog = ctx.value;
    if (catalog.claude === undefined && catalog.codex === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'a catalog lists models for "claude:", "codex:" or both',
        input: catalog,
        path: [],
      });
    }
    catalog.codex?.models.forEach((model, index) => {
      if (model.suffix === undefined) return;
      ctx.issues.push({
        code: 'custom',
        message: `"suffix" is Claude Code's context suffix; Codex takes ${model.id} as it is`,
        input: model.suffix,
        path: ['codex', 'models', index, 'suffix'],
      });
    });
    if (catalog.codex?.tiers !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: '"tiers" pins Claude Code\'s tier slots; Codex has none',
        input: catalog.codex.tiers,
        path: ['codex', 'tiers'],
      });
    }
  });
export type ModelCatalogFile = z.infer<typeof ModelCatalogFileSchema>;

/** A catalog, read: its id (the file name) and where it came from. */
export interface ModelCatalog extends ModelCatalogFile {
  readonly id: string;
  readonly origin: 'built-in' | 'published' | 'file';
}

/** The half a runtime of `harness` reads, when the catalog has one. */
export const catalogHalf = (catalog: ModelCatalogFile, harness: HarnessKind): CatalogHalf | undefined =>
  catalog[harness];

/** The model a half launches with when nobody names one. Present by construction. */
export const catalogDefault = (half: CatalogHalf): CatalogModel =>
  half.models.find(model => model.default) as CatalogModel;

/**
 * The variables a Claude Code half pins its tier slots with, each set to the slot's model. Empty for a
 * half that pins none (Claude Code's own aliases then decide).
 */
export function catalogTierEnvironment(half: CatalogHalf): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(half.tiers ?? {}).flatMap(([slot, value]) =>
      value === undefined ? [] : [[CLAUDE_TIER_VARIABLES[slot as ClaudeTierSlot], value]],
    ),
  );
}

/**
 * The catalog model a model id or Claude Code alias names in this half: the id itself, or the model a
 * tier slot (`opus`) is pinned to. `undefined` when it names none of them.
 */
export function catalogModelFor(half: CatalogHalf, id: string): CatalogModel | undefined {
  const bare = slotModelId(id);
  const exact = half.models.find(model => model.id === bare);
  if (exact !== undefined) return exact;
  const pinned = half.tiers?.[bare as ClaudeTierSlot];
  return pinned === undefined ? undefined : half.models.find(model => model.id === slotModelId(pinned));
}

/** The value a CLI is handed this model as: its id with its context suffix, when it has one. */
export const catalogModelValue = (model: Pick<CatalogModel, 'id' | 'suffix'>): string =>
  `${model.id}${model.suffix ?? ''}`;
