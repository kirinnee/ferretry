/**
 * The models a session that is ALREADY RUNNING may be switched to.
 *
 * One owner per harness, and neither of them is a table in this repository.
 *
 *   * A Claude account declares what it serves in the published fleet manifest, so the catalog is
 *     `servableModels()` over that account and nothing else. The source kept a second declaration —
 *     a list of wrapper-name regexes mapping an executable to the models it offers — and that is
 *     precisely the shape of duplication {@link ../../core/inventory.ts} exists to delete: a manifest
 *     could mark a model unavailable while the regex table went on offering it.
 *   * A Codex account advertises its own catalog over its app-server, and only the live account can
 *     answer it: the same executable, the same harness home, the same provider configuration and the
 *     same working directory are all inputs. So there is no static Codex list here at all, and a
 *     catalog that could not be read is an ERROR rather than an empty list — the browser's native
 *     picker fallback fires on both, but only one of them is honest about why.
 *
 * EFFORTS FOLLOW THE CATALOG. An account whose login reads a model catalog (docs/model-catalog.md)
 * publishes, per model, the efforts that model takes — an empty list means none, and the picker offers
 * none — and its tier, so the picker groups the list. An account WITHOUT a catalog publishes no levels,
 * and the browser reads that as "use Claude Code's own levels", which take any model. Codex's levels
 * come from its own app-server per model, and the catalog adds only the tier where an id matches.
 */

import type { RuntimeModelCatalog, RuntimeModelChoice } from '@ferretry/protocol';
import { type CoreAccount, type CoreAccountModel, servableModels } from '../../core/inventory.ts';

/**
 * What one Claude account may be switched to mid-session.
 *
 * An unavailable account answers with no choices, because {@link servableModels} filters it to
 * nothing — an account that cannot serve a session cannot serve a switch into one either.
 */
export function claudeRuntimeCatalog(account: CoreAccount): RuntimeModelCatalog {
  return {
    harness: 'claude',
    source: 'wrapper-inventory',
    choices: servableModels(account).map(model => ({
      value: model.id,
      label: model.displayName ?? model.id,
      ...catalogFacts(model),
      ...(account.defaultModel === model.id ? { isDefault: true as const } : {}),
      reasoningEfforts: (model.efforts ?? []).map(value => ({ value })),
      ...(model.defaultEffort === undefined ? {} : { defaultReasoningEffort: model.defaultEffort }),
    })),
    ...(account.modelCatalog === undefined ? {} : { catalog: { ...account.modelCatalog } }),
  };
}

/** The tier and context window a catalog gave a model, for the picker to group and describe by. */
const catalogFacts = (model: CoreAccountModel): Pick<RuntimeModelChoice, 'tier' | 'context'> => ({
  ...(model.tier === undefined ? {} : { tier: model.tier }),
  ...(model.context === undefined ? {} : { context: model.context }),
});

/**
 * What one Codex account advertised, restated as the wire catalog. The app-server's list is the only
 * one Codex's own picker can switch to, so it stays the list; where the account's catalog describes an
 * advertised id, the choice gains that model's tier and label for the picker to group by.
 */
export function codexRuntimeCatalog(
  choices: readonly RuntimeModelChoice[],
  account?: Pick<CoreAccount, 'models' | 'modelCatalog'>,
): RuntimeModelCatalog {
  const described = new Map((account?.models ?? []).map(model => [model.id, model]));
  return {
    harness: 'codex',
    source: 'codex-app-server',
    choices: choices.map(choice => {
      const model = described.get(choice.value);
      return model === undefined
        ? choice
        : { ...choice, label: model.displayName ?? choice.label, ...catalogFacts(model) };
    }),
    ...(account?.modelCatalog === undefined ? {} : { catalog: { ...account.modelCatalog } }),
  };
}

/** The model and effort values a Codex catalog offers, for a switch that must name an exact target. */
export function codexSwitchContext(catalog: RuntimeModelCatalog): {
  readonly choices: readonly {
    readonly value: string;
    readonly reasoningEfforts: readonly { readonly value: string }[];
    readonly defaultReasoningEffort?: string;
  }[];
} {
  return {
    choices: catalog.choices.map(choice => ({
      value: choice.value,
      reasoningEfforts: choice.reasoningEfforts.map(effort => ({ value: effort.value })),
      ...(choice.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: choice.defaultReasoningEffort }),
    })),
  };
}
