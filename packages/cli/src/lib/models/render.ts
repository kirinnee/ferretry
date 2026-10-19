import type { ModelCatalogEntryView, ModelCatalogRefreshResult, ModelCatalogsView } from '@ferretry/protocol';

const TIER_WORDS = { best: 'most capable', balanced: 'balanced', fast: 'fast' } as const;

const contextWords = (tokens: number | undefined): string =>
  tokens === undefined
    ? ''
    : tokens >= 1_000_000
      ? ` · ${tokens / 1_000_000}M context`
      : ` · ${Math.round(tokens / 1000)}K context`;

const modelLine = (model: ModelCatalogEntryView): string =>
  `    ${model.default ? '*' : ' '} ${model.id}  ${model.label} (${TIER_WORDS[model.tier]}${contextWords(model.context)}${
    model.efforts.length === 0 ? '' : ` · effort ${model.efforts.join('/')}`
  })`;

/** The published catalog's state in one line. */
function publishedLine(view: ModelCatalogsView): string {
  const published = view.published;
  if (!published.enabled) return `Published catalog: not followed (FY_MODEL_CATALOG=off)`;
  const version = published.version === undefined ? 'none taken yet' : `version ${published.version}`;
  const checked = published.checkedAt === undefined ? 'never checked' : `checked ${published.checkedAt}`;
  return `Published catalog from ${published.origin}: ${version}, ${checked}`;
}

/** `fy models list`: each catalog, where it came from, and its models by CLI. `*` marks the default. */
export function renderModelCatalogs(view: ModelCatalogsView): string {
  const lines = [publishedLine(view)];
  for (const catalog of view.catalogs) {
    lines.push(
      '',
      `${catalog.id} — ${catalog.label} (${catalog.origin}, verified ${catalog.verified}${catalog.customIds ? ', takes any id' : ''})`,
    );
    for (const harness of ['claude', 'codex'] as const) {
      const models = catalog[harness];
      if (models === undefined) continue;
      lines.push(`  ${harness === 'claude' ? 'Claude Code' : 'Codex'}:`, ...models.map(modelLine));
    }
  }
  return lines.join('\n');
}

const OUTCOME_WORDS: Readonly<Record<ModelCatalogRefreshResult['outcome'], string>> = {
  updated: 'A newer model catalog was published; it is in effect now',
  unchanged: 'The published model catalog has not changed',
  'not-due': 'The model catalog was checked recently',
  unreachable: 'The published model catalog could not be reached; the one held stays in effect',
  refused: 'The published model catalog did not check; the one held stays in effect',
  disabled: 'This daemon follows no published model catalog (FY_MODEL_CATALOG=off)',
};

/** `fy models refresh`: what the check came to, in one sentence. */
export function renderModelRefresh(result: ModelCatalogRefreshResult): string {
  const version = result.version === undefined ? '' : ` (version ${result.version})`;
  const reason = result.reason === undefined ? '' : `: ${result.reason}`;
  return `${OUTCOME_WORDS[result.outcome]}${version}${reason}.`;
}
