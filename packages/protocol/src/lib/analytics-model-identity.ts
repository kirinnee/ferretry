/**
 * How a model spelling becomes one comparable identity — for every program that has to agree.
 *
 * THE DECISION LIVES HERE rather than in the daemon that first needed it. A price is looked up by
 * normalized identity, and a browser that renders, edits or previews that price has to reach the same
 * answer as the daemon that applied it, or the two disagree about which row an operator just edited.
 * A constant would not have been enough: the question a caller asks is "are these the same model",
 * and that is a function, not a table.
 */

export interface AnalyticsModelAliasGroup {
  readonly modelId: string;
  readonly aliases: readonly string[];
}

export interface AnalyticsModelIdentity {
  /** The exact selector or transcript spelling retained as evidence. */
  readonly raw: string;
  /** Stable, case-folded identity used for comparisons and pricing. */
  readonly modelId: string;
  /** Selector-only variant such as `1m`, kept out of the model identity. */
  readonly variant: string | null;
  /** Context-window choice derived from the selector variant when known. */
  readonly contextWindow: number | null;
  /** Provider revision suffix retained separately from the stable identity. */
  readonly revision: string | null;
}

interface ParsedModelSpelling {
  readonly base: string;
  readonly variant: string | null;
  readonly contextWindow: number | null;
  readonly revision: string | null;
}

const SELECTOR_VARIANT = /\s*\[([0-9]+(?:\.[0-9]+)?)m\]\s*$/i;
const MODEL_REVISION = /(?:-|@)([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$/;

function parseModelSpelling(value: string): ParsedModelSpelling {
  const folded = value.trim().toLowerCase();
  const variantMatch = folded.match(SELECTOR_VARIANT);
  const variant = variantMatch?.[1] === undefined ? null : `${variantMatch[1]}m`;
  const contextWindow = variantMatch?.[1] === undefined ? null : Number(variantMatch[1]) * 1_000_000;
  const withoutVariant = variantMatch === null ? folded : folded.slice(0, variantMatch.index).trimEnd();
  const revisionMatch = withoutVariant.match(MODEL_REVISION);

  return {
    base: revisionMatch === null ? withoutVariant : withoutVariant.slice(0, revisionMatch.index),
    variant,
    contextWindow,
    revision: revisionMatch?.[1] ?? null,
  };
}

function normalizeAlias(value: string): string {
  return parseModelSpelling(value).base;
}

/**
 * Normalize selector and transcript spellings without conflating their evidence.
 * Callers keep one identity for the selected/display model and another for the
 * transcript pricing model; this function only makes each value comparable.
 */
export function normalizeAnalyticsModelIdentity(
  raw: string | null | undefined,
  aliasGroups: readonly AnalyticsModelAliasGroup[] = [],
): AnalyticsModelIdentity | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;

  const parsed = parseModelSpelling(raw);
  const matchingIds = new Set(
    aliasGroups
      .filter(
        group =>
          normalizeAlias(group.modelId) === parsed.base ||
          group.aliases.some(alias => normalizeAlias(alias) === parsed.base),
      )
      .map(group => normalizeAlias(group.modelId)),
  );
  const [onlyMatch] = matchingIds;

  return {
    raw,
    modelId: matchingIds.size === 1 && onlyMatch !== undefined ? onlyMatch : parsed.base,
    variant: parsed.variant,
    contextWindow: parsed.contextWindow,
    revision: parsed.revision,
  };
}
