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
 * A Claude choice advertises NO reasoning levels, and that absence is load-bearing rather than a
 * gap. Claude sets effort with a native command that takes any of its levels whatever the model is,
 * so the levels are not a property OF a model and publishing them per choice would state a
 * dependency that does not exist. Codex's levels genuinely are per model — its picker offers a
 * different submenu for each — which is why only that side carries them.
 */

import type { RuntimeModelCatalog, RuntimeModelChoice } from '@ferretry/protocol';
import { type CoreAccount, servableModels } from '../../core/inventory.ts';

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
      ...(account.defaultModel === model.id ? { isDefault: true as const } : {}),
      reasoningEfforts: [],
    })),
  };
}

/** What one Codex account advertised, restated as the wire catalog. */
export function codexRuntimeCatalog(choices: readonly RuntimeModelChoice[]): RuntimeModelCatalog {
  return { harness: 'codex', source: 'codex-app-server', choices: [...choices] };
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
