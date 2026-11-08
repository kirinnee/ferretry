/**
 * What a runtime reads of a model catalog (docs/model-catalog.md): the catalog's shape is Logins' (its contract
 * carries the schemas); the helpers that pick a half, a default and a Claude Code tier slot out of one are here,
 * because a runtime's models are derived from them at apply time (`./runtime.ts`).
 *
 * GAP(logins): these helpers are Logins' too (today's `models/schema.ts`); delete this file when Logins' contract
 * exports them.
 *
 * Pure.
 */
import type { ModelCatalogFile, ModelTierSchema } from '@ferretry/plugin-logins/contract';
import type { z } from 'zod';
import type { HarnessKind } from '../manifest.ts';

export type ModelTier = z.infer<typeof ModelTierSchema>;
export type CatalogHalf = NonNullable<ModelCatalogFile['claude']>;
export type CatalogModel = CatalogHalf['models'][number];
export type { ModelCatalogFile };

/**
 * Claude Code's tier slots and the variable each is set through. `subagent` is the model Claude Code's
 * subagents run on. Pinned by Ferretry so `/model opus` lands on the catalog's model on every backend.
 */
const CLAUDE_TIER_VARIABLES = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
} as const;
type ClaudeTierSlot = keyof typeof CLAUDE_TIER_VARIABLES;

/** A slot's value without its context suffix: the catalog id it names. */
const slotModelId = (value: string): string => value.replace(/\[[^\]]*\]$/u, '');

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
